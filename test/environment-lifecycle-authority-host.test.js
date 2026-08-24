import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentLifecycleAuthorityHost } from '../src/app/environment-lifecycle-authority-host.js';
import {
  createConfiguredLifecycleAuthorityClient,
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

test('protected host owns both endpoint capabilities around one EnvironmentOperator', async (t) => {
  if (!['linux', 'win32'].includes(process.platform)) return t.skip('local authority host supports Windows and Linux');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-authority-host-'));
  const endpointStateDirectory = process.platform === 'win32'
    ? path.win32.join('C:\\', 'DevBridge-Test', path.basename(temp), 'ordinary-state')
    : path.join(temp, 'ordinary-state');
  const protectedStateDirectory = process.platform === 'win32'
    ? path.win32.join('C:\\', 'ProgramData', 'DevBridge-Test', path.basename(temp), 'protected-state')
    : path.join(temp, 'protected-state');
  const runDirectory = process.platform === 'linux' ? path.join(temp, 'run') : '/run/devbridge';
  if (process.platform === 'linux') {
    const identity = environmentLifecycleAuthorityIdentity(endpointStateDirectory);
    await mkdir(path.join(runDirectory, identity, 'read'), { recursive: true });
    await mkdir(path.join(runDirectory, identity, 'mutation'), { recursive: true });
  }
  const calls = [];
  const host = await createEnvironmentLifecycleAuthorityHost({
    stateDirectory: protectedStateDirectory,
    endpointStateDirectory,
    platform: process.platform,
    runDirectory,
    operator: operatorFixture(calls),
  });
  try {
    assert.equal(host.authorityIdentity, environmentLifecycleAuthorityIdentity(endpointStateDirectory));
    assert.notEqual(
      host.authorityIdentity,
      environmentLifecycleAuthorityIdentity(protectedStateDirectory),
      'protected storage location must not define the public endpoint identity',
    );
    await host.start();
    const client = createConfiguredLifecycleAuthorityClient({
      stateDirectory: endpointStateDirectory,
      platform: process.platform,
      runDirectory,
      connectTimeoutMs: 1000,
    });
    assert.equal((await client.status(ENV)).environmentIdentity, ENV);
    const plan = await client.plan('recreate', ENV);
    await client.run('recreate', ENV, { approval: plan.authorizationSubject });
    assert.deepEqual(calls, [
      ['status', ENV],
      ['plan', 'recreate', ENV],
      ['run', 'recreate', ENV, { approval: 'recreate-subject' }],
    ]);
    await host.close();
    await assert.rejects(client.status(ENV), /authority is unavailable/u);
  } finally {
    await host.close();
    await rm(temp, { recursive: true, force: true });
  }
});
