import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentLifecycleAuthorityHost } from '../src/app/environment-lifecycle-authority-host.js';
import {
  createConfiguredEnvironmentActivityClient,
  environmentActivityAuthorityIdentity,
} from '../src/runtime/environment-activity-authority-transport.js';
import {
  createConfiguredLifecycleAuthorityClient,
  environmentLifecycleAuthorityIdentity,
} from '../src/runtime/environment-lifecycle-authority-transport.js';
import {
  createConfiguredEnvironmentConfigurationClient,
  environmentConfigurationAuthorityIdentity,
} from '../src/runtime/environment-configuration-authority-transport.js';

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

test('protected host attaches lifecycle and configuration capabilities without merging their contracts', async (t) => {
  if (!['linux', 'win32'].includes(process.platform)) return t.skip('local authority host supports Windows and Linux');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-authority-host-'));
  const stateDirectory = process.platform === 'win32'
    ? path.win32.join('C:\\', 'DevBridge-Test', path.basename(temp), 'state')
    : path.join(temp, 'state');
  const runDirectory = process.platform === 'linux' ? path.join(temp, 'run') : '/run/devbridge';
  if (process.platform === 'linux') {
    const identity = environmentLifecycleAuthorityIdentity(stateDirectory);
    await mkdir(path.join(runDirectory, identity, 'read'), { recursive: true });
    await mkdir(path.join(runDirectory, identity, 'mutation'), { recursive: true });
    const configurationIdentity = environmentConfigurationAuthorityIdentity(stateDirectory, { platform: process.platform });
    await mkdir(path.join(runDirectory, configurationIdentity, 'configuration'), { recursive: true });
    const activityIdentity = environmentActivityAuthorityIdentity(stateDirectory, { platform: process.platform });
    await mkdir(path.join(runDirectory, activityIdentity, 'activity'), { recursive: true });
  }
  const calls = [];
  const configurationCalls = [];
  const activityCalls = [];
  const host = await createEnvironmentLifecycleAuthorityHost({
    stateDirectory,
    platform: process.platform,
    runDirectory,
    operator: operatorFixture(calls),
    configuration: {
      async inspect() { configurationCalls.push(['inspect']); return { ready: true }; },
      async reconcile(value) { configurationCalls.push(['reconcile', value]); return { ready: true, changed: true, ...value }; },
    },
    activity: {
      async inspect() { activityCalls.push(['inspect']); return { ready: true, identity: 'foundation-a' }; },
      async list() { activityCalls.push(['list']); return []; },
      async observe(value) { activityCalls.push(['observe', value]); throw new Error('unused'); },
      async prepare(value) { activityCalls.push(['prepare', value]); throw new Error('unused'); },
      async exchange(value) { activityCalls.push(['exchange', value]); throw new Error('unused'); },
    },
  });
  try {
    assert.equal(host.authorityIdentity, environmentLifecycleAuthorityIdentity(stateDirectory));
    await host.start();
    const client = createConfiguredLifecycleAuthorityClient({
      stateDirectory,
      platform: process.platform,
      runDirectory,
      connectTimeoutMs: 1000,
    });
    assert.equal((await client.status(ENV)).environmentIdentity, ENV);
    const plan = await client.plan('recreate', ENV);
    await client.run('recreate', ENV, { approval: plan.authorizationSubject });
    const configurationClient = createConfiguredEnvironmentConfigurationClient({
      stateDirectory,
      platform: process.platform,
      runDirectory,
      connectTimeoutMs: 1000,
    });
    assert.deepEqual(await configurationClient.inspect(), { ready: true });
    const subject = 'd'.repeat(64);
    assert.deepEqual(
      await configurationClient.reconcile({ revision: 3, subject }),
      { ready: true, changed: true, revision: 3, subject },
    );
    const activityClient = createConfiguredEnvironmentActivityClient({
      stateDirectory,
      platform: process.platform,
      runDirectory,
      connectTimeoutMs: 1000,
    });
    assert.deepEqual(await activityClient.inspect(), { ready: true, identity: 'foundation-a', reason: null });
    assert.deepEqual(await activityClient.list(), []);
    assert.deepEqual(calls, [
      ['status', ENV],
      ['plan', 'recreate', ENV],
      ['run', 'recreate', ENV, { approval: 'recreate-subject' }],
    ]);
    assert.deepEqual(configurationCalls, [
      ['inspect'],
      ['reconcile', { revision: 3, subject }],
    ]);
    assert.deepEqual(activityCalls, [['inspect'], ['list']]);
    await host.close();
    await assert.rejects(client.status(ENV), /authority is unavailable/u);
    await assert.rejects(configurationClient.inspect(), /authority is unavailable/u);
    await assert.rejects(activityClient.inspect(), /authority is unavailable/u);
  } finally {
    await host.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('configuration endpoint startup failure rolls back both lifecycle endpoints', async () => {
  const calls = [];
  const server = (name, failure = null) => ({
    async start() { calls.push(['start', name]); if (failure) throw failure; },
    async close() { calls.push(['close', name]); },
  });
  const host = await createEnvironmentLifecycleAuthorityHost({
    stateDirectory: 'C:\\state',
    platform: 'win32',
    operator: operatorFixture([]),
    configuration: { async inspect() { return { ready: true }; }, async reconcile() { throw new Error('unused'); } },
  }, {
    lifecycleServerFactory: () => ({
      authorityIdentity: 'a'.repeat(32),
      read: server('read'),
      mutation: server('mutation'),
    }),
    configurationServerFactory: () => server('configuration', new Error('configuration unavailable')),
  });
  await assert.rejects(host.start(), /configuration unavailable/u);
  assert.deepEqual(calls, [
    ['start', 'read'],
    ['start', 'mutation'],
    ['start', 'configuration'],
    ['close', 'mutation'],
    ['close', 'read'],
  ]);
  await host.close();
  assert.equal(calls.length, 5);
});

test('activity endpoint startup failure rolls back every previously attached capability in reverse order', async () => {
  const calls = [];
  const server = (name, failure = null) => ({
    async start() { calls.push(['start', name]); if (failure) throw failure; },
    async close() { calls.push(['close', name]); },
  });
  const host = await createEnvironmentLifecycleAuthorityHost({
    stateDirectory: 'C:\\state',
    platform: 'win32',
    operator: operatorFixture([]),
    configuration: { async inspect() { return { ready: true }; }, async reconcile() { throw new Error('unused'); } },
    activity: {
      async inspect() { return { ready: true }; },
      async list() { return []; },
      async observe() { throw new Error('unused'); },
      async prepare() { throw new Error('unused'); },
      async exchange() { throw new Error('unused'); },
    },
  }, {
    lifecycleServerFactory: () => ({
      authorityIdentity: 'a'.repeat(32),
      read: server('read'),
      mutation: server('mutation'),
    }),
    configurationServerFactory: () => server('configuration'),
    activityServerFactory: () => server('activity', new Error('activity unavailable')),
  });
  await assert.rejects(host.start(), /activity unavailable/u);
  assert.deepEqual(calls, [
    ['start', 'read'],
    ['start', 'mutation'],
    ['start', 'configuration'],
    ['start', 'activity'],
    ['close', 'configuration'],
    ['close', 'mutation'],
    ['close', 'read'],
  ]);
  await host.close();
});

test('unattached configuration topology has no configuration-server dependency', async () => {
  const calls = [];
  const server = (name) => ({
    async start() { calls.push(['start', name]); },
    async close() { calls.push(['close', name]); },
  });
  const host = await createEnvironmentLifecycleAuthorityHost({
    stateDirectory: 'C:\\state',
    platform: 'win32',
    operator: operatorFixture([]),
  }, {
    lifecycleServerFactory: () => ({
      authorityIdentity: 'a'.repeat(32),
      read: server('read'),
      mutation: server('mutation'),
    }),
    configurationServerFactory: null,
  });
  await host.start();
  await host.close();
  assert.deepEqual(calls, [
    ['start', 'read'],
    ['start', 'mutation'],
    ['close', 'mutation'],
    ['close', 'read'],
  ]);
});
