import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runDevBridgeSetup } from '../src/app/setup.js';

function repository(index) {
  return { id: index + 1, full_name: `owner/repo-${index}`, private: false, archived: false, disabled: false, permissions: { push: true } };
}

function memoryStore(initial = null) {
  let value = initial;
  return {
    async get() { return structuredClone(value); },
    async set(_key, next) { value = structuredClone(next); },
    value: () => structuredClone(value),
  };
}

function dependencies({ count = 2, physical = null, initialState = null } = {}) {
  const store = memoryStore(initialState);
  const calls = { authority: 0, canaryStatus: 0, canaryRun: 0 };
  return {
    calls,
    store,
    deps: {
      platform: 'win32',
      now: () => new Date('2026-08-23T20:00:00Z'),
      storeFactory: () => store,
      pathInstaller: async ({ home }) => ({ protocol: 'test/path', command: path.join(home, 'bin', 'devbridge.cmd'), persisted: true, changed: false, requiresNewShell: false, temporaryCommand: null }),
      tokenResolver: async () => 'test-token',
      clientFactory: () => ({}),
      discover: async () => ({ identity: { id: 42, login: 'owner' }, repositories: Array.from({ length: count }, (_, index) => repository(index)) }),
      releaseAuthority: async ({ home }) => ({ keyring: path.join(home, 'authority', 'ubuntu.gpg') }),
      authorityFactory: async ({ snapshot }) => { calls.authority += 1; return { protocol: 'test/authority', snapshot }; },
      canaryFactory: () => ({
        async status() {
          calls.canaryStatus += 1;
          return physical ?? { state: 'absent', blocked: false, complete: false, reason: null, preflight: { ready: true } };
        },
        async run() { calls.canaryRun += 1; throw new Error('setup must never construct'); },
      }),
    },
  };
}

test('setup reaches the physical status gate without invoking construction', async () => {
  const fixture = dependencies();
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-test') }, fixture.deps);
  assert.equal(result.readyForConstruction, true);
  assert.equal(result.phase, 'ready-for-construction');
  assert.equal(result.repositories.selectedCount, 2);
  assert.equal(fixture.calls.canaryStatus, 1);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup preserves the repository selection boundary before image authority work', async () => {
  const fixture = dependencies({ count: 31 });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-many') }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.match(result.blocker, /31 eligible repositories/u);
  assert.equal(fixture.calls.authority, 0);
  assert.equal(fixture.calls.canaryStatus, 0);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup reports physical preflight blockers without crossing the status gate', async () => {
  const fixture = dependencies({ physical: { state: 'blocked', blocked: true, complete: false, reason: 'Hyper-V provider is unavailable', preflight: { ready: false } } });
  const result = await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-blocked') }, fixture.deps);
  assert.equal(result.blocked, true);
  assert.equal(result.readyForConstruction, false);
  assert.match(result.blocker, /Hyper-V/u);
  assert.equal(fixture.calls.canaryStatus, 1);
  assert.equal(fixture.calls.canaryRun, 0);
});

test('setup re-entry reuses the exact persisted package snapshot', async () => {
  const snapshot = '20260820T170000Z';
  const fixture = dependencies({ initialState: { protocol: 'devbridge/setup-status-v1', ubuntu: { snapshot } } });
  let observed = null;
  fixture.deps.authorityFactory = async ({ snapshot: value }) => { observed = value; return { protocol: 'test/authority', snapshot: value }; };
  await runDevBridgeSetup({ home: path.join(os.tmpdir(), 'db-setup-reentry') }, fixture.deps);
  assert.equal(observed, snapshot);
});
