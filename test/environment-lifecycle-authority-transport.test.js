import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
} from '../src/runtime/environment-lifecycle-authority.js';
import {
  createConfiguredLifecycleAuthorityClient,
  createLifecycleAuthoritySocketExchange,
  createLifecycleAuthoritySocketServer,
  createLifecycleAuthoritySocketServers,
  environmentLifecycleAuthorityEndpoint,
  environmentLifecycleAuthorityIdentity,
} from '../src/runtime/environment-lifecycle-authority-transport.js';

const ENV = 'environment-test';

function operatorFixture(calls) {
  return {
    async inspect() { calls.push(['inspect']); return { state: 'ready' }; },
    async list() { calls.push(['list']); return [{ environmentIdentity: ENV }]; },
    async status(identity) { calls.push(['status', identity]); return { environmentIdentity: identity, health: { state: 'ready' } }; },
    async plan(operation, identity) { calls.push(['plan', operation, identity]); return { operation, environmentIdentity: identity, authorizationSubject: `${operation}-subject` }; },
    async run(operation, identity, options) { calls.push(['run', operation, identity, options]); return { operation, environmentIdentity: identity, state: 'complete' }; },
    async resume(identity, options) { calls.push(['resume', identity, options]); return { environmentIdentity: identity, state: 'complete' }; },
    async setupReentry(identity) { calls.push(['setupReentry', identity]); return { action: 'setup-reentry', environmentIdentity: identity }; },
  };
}

async function withServers(fn) {
  if (!['linux', 'win32'].includes(process.platform)) return;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-authority-'));
  const stateDirectory = process.platform === 'win32'
    ? path.win32.join('C:\\', 'DevBridge-Test', path.basename(temp), 'state')
    : path.join(temp, 'state');
  const runDirectory = process.platform === 'linux' ? path.join(temp, 'run') : '/run/devbridge';
  if (process.platform === 'linux') {
    const identity = environmentLifecycleAuthorityIdentity(stateDirectory);
    await mkdir(path.join(runDirectory, identity, 'read'), { recursive: true });
    await mkdir(path.join(runDirectory, identity, 'mutation'), { recursive: true });
  }
  const calls = [];
  const servers = createLifecycleAuthoritySocketServers({
    operator: operatorFixture(calls),
    stateDirectory,
    platform: process.platform,
    runDirectory,
  });
  await servers.read.start();
  await servers.mutation.start();
  try {
    await fn({ stateDirectory, runDirectory, calls, servers });
  } finally {
    await servers.read.close();
    await servers.mutation.close();
    await rm(temp, { recursive: true, force: true });
  }
}

test('authority identity is a path-free normalized state-owner identity', () => {
  const windowsA = environmentLifecycleAuthorityIdentity('C:\\DevBridge\\State', { platform: 'win32' });
  const windowsB = environmentLifecycleAuthorityIdentity('c:\\devbridge\\state\\', { platform: 'win32' });
  assert.equal(windowsA, windowsB);
  assert.match(windowsA, /^[0-9a-f]{32}$/u);
  assert.equal(windowsA.includes('devbridge'), false);

  const linux = environmentLifecycleAuthorityIdentity('/srv/devbridge/state/', { platform: 'linux' });
  assert.match(linux, /^[0-9a-f]{32}$/u);
  assert.throws(() => environmentLifecycleAuthorityIdentity('relative/state', { platform: 'linux' }), /must be absolute/u);
});

test('authority endpoint is identity-derived and access-class separated', () => {
  const identity = '00112233445566778899aabbccddeeff';
  assert.equal(
    environmentLifecycleAuthorityEndpoint({ authorityIdentity: identity, access: 'read', platform: 'win32' }),
    '\\\\.\\pipe\\devbridge-environment-00112233445566778899aabbccddeeff-read-v1',
  );
  assert.equal(
    environmentLifecycleAuthorityEndpoint({ authorityIdentity: identity, access: 'mutation', platform: 'linux' }),
    '/run/devbridge/00112233445566778899aabbccddeeff/mutation/environment-v1.sock',
  );
  assert.throws(() => environmentLifecycleAuthorityEndpoint({ authorityIdentity: 'bad', access: 'read', platform: 'linux' }), /identity is invalid/u);
  assert.throws(() => environmentLifecycleAuthorityEndpoint({ authorityIdentity: identity, access: 'write', platform: 'linux' }), /access class is invalid/u);
  assert.throws(() => environmentLifecycleAuthorityEndpoint({ authorityIdentity: identity, access: 'read', platform: 'darwin' }), /unsupported/u);
});

test('socket client preserves split read and mutation routing', async (t) => {
  if (!['linux', 'win32'].includes(process.platform)) return t.skip('local authority transport supports Windows and Linux');
  await withServers(async ({ stateDirectory, runDirectory, calls }) => {
    const client = createConfiguredLifecycleAuthorityClient({
      stateDirectory,
      platform: process.platform,
      runDirectory,
      connectTimeoutMs: 1000,
    });
    const plan = await client.plan('reset', ENV);
    await client.run('reset', ENV, { approval: plan.authorizationSubject });
    await client.setupReentry(ENV);
    assert.deepEqual(calls, [
      ['plan', 'reset', ENV],
      ['run', 'reset', ENV, { approval: 'reset-subject' }],
      ['setupReentry', ENV],
    ]);
  });
});

test('read endpoint cannot be used as a mutation capability', async (t) => {
  if (!['linux', 'win32'].includes(process.platform)) return t.skip('local authority transport supports Windows and Linux');
  await withServers(async ({ stateDirectory, runDirectory, calls }) => {
    const authorityIdentity = environmentLifecycleAuthorityIdentity(stateDirectory);
    const endpoint = environmentLifecycleAuthorityEndpoint({
      authorityIdentity,
      access: 'read',
      platform: process.platform,
      runDirectory,
    });
    const exchange = createLifecycleAuthoritySocketExchange({ endpoint, connectTimeoutMs: 1000 });
    const response = await exchange({
      protocol: ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
      requestId: '11111111-1111-4111-8111-111111111111',
      operation: 'run',
      payload: { operation: 'reset', identity: ENV, approval: 'reset-subject' },
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'OPERATION_NOT_ALLOWED');
    assert.equal(calls.length, 0);
  });
});

test('connect timeout does not become an operation timeout', async (t) => {
  if (!['linux', 'win32'].includes(process.platform)) return t.skip('local authority transport supports Windows and Linux');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-authority-long-'));
  const stateDirectory = process.platform === 'win32'
    ? path.win32.join('C:\\', 'DevBridge-Test', path.basename(temp), 'state')
    : path.join(temp, 'state');
  const runDirectory = process.platform === 'linux' ? path.join(temp, 'run') : '/run/devbridge';
  if (process.platform === 'linux') {
    const identity = environmentLifecycleAuthorityIdentity(stateDirectory);
    await mkdir(path.join(runDirectory, identity, 'read'), { recursive: true });
    await mkdir(path.join(runDirectory, identity, 'mutation'), { recursive: true });
  }
  const calls = [];
  const operator = operatorFixture(calls);
  operator.status = async (identity) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    calls.push(['status', identity]);
    return { environmentIdentity: identity, health: { state: 'ready' } };
  };
  const servers = createLifecycleAuthoritySocketServers({ operator, stateDirectory, platform: process.platform, runDirectory });
  await servers.read.start();
  await servers.mutation.start();
  try {
    const client = createConfiguredLifecycleAuthorityClient({ stateDirectory, platform: process.platform, runDirectory, connectTimeoutMs: 100 });
    const result = await client.status(ENV);
    assert.equal(result.environmentIdentity, ENV);
    assert.deepEqual(calls, [['status', ENV]]);
  } finally {
    await servers.read.close();
    await servers.mutation.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('unavailable endpoint fails closed', async () => {
  if (!['linux', 'win32'].includes(process.platform)) return;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-authority-missing-'));
  const stateDirectory = process.platform === 'win32'
    ? path.win32.join('C:\\', 'DevBridge-Test', path.basename(temp), 'state')
    : path.join(temp, 'state');
  const runDirectory = process.platform === 'linux' ? path.join(temp, 'run') : '/run/devbridge';
  try {
    const client = createConfiguredLifecycleAuthorityClient({ stateDirectory, platform: process.platform, runDirectory, connectTimeoutMs: 100 });
    await assert.rejects(client.status(ENV), /authority is unavailable/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('server closes multi-frame requests without dispatch', async (t) => {
  if (!['linux', 'win32'].includes(process.platform)) return t.skip('local authority transport supports Windows and Linux');
  await withServers(async ({ stateDirectory, runDirectory, calls }) => {
    const authorityIdentity = environmentLifecycleAuthorityIdentity(stateDirectory);
    const endpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'read', platform: process.platform, runDirectory });
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      socket.once('connect', () => {
        const request = JSON.stringify({
          protocol: ENVIRONMENT_LIFECYCLE_AUTHORITY_REQUEST_PROTOCOL,
          requestId: '11111111-1111-4111-8111-111111111111',
          operation: 'status',
          payload: { identity: ENV },
        });
        socket.end(`${request}\n${request}\n`);
      });
      socket.once('error', reject);
      socket.once('close', resolve);
    });
    assert.equal(calls.length, 0);
  });
});

test('server bounds idle pre-request connections without dispatch', async (t) => {
  if (!['linux', 'win32'].includes(process.platform)) return t.skip('local authority transport supports Windows and Linux');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-authority-idle-'));
  const stateDirectory = process.platform === 'win32'
    ? path.win32.join('C:\\', 'DevBridge-Test', path.basename(temp), 'state')
    : path.join(temp, 'state');
  const runDirectory = process.platform === 'linux' ? path.join(temp, 'run') : '/run/devbridge';
  const identity = environmentLifecycleAuthorityIdentity(stateDirectory);
  if (process.platform === 'linux') await mkdir(path.join(runDirectory, identity, 'read'), { recursive: true });
  const endpoint = environmentLifecycleAuthorityEndpoint({ authorityIdentity: identity, access: 'read', platform: process.platform, runDirectory });
  let dispatched = 0;
  const server = createLifecycleAuthoritySocketServer({
    endpoint,
    requestTimeoutMs: 100,
    handler: async () => { dispatched += 1; return {}; },
  });
  await server.start();
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      socket.once('connect', () => socket.write('{"protocol":'));
      socket.once('error', reject);
      socket.once('close', resolve);
    });
    assert.equal(dispatched, 0);
  } finally {
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
});
