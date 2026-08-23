import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runDevBridgeSetup } from '../src/app/setup.js';

function store() {
  let value = null;
  return { async get() { return value; }, async set(_key, next) { value = structuredClone(next); } };
}

test('setup reuses DEVBRIDGE_HOME and the established DevBridge token environment', async () => {
  const home = path.join(os.tmpdir(), 'devbridge-existing-installation');
  let observedToken = null;
  const result = await runDevBridgeSetup({
    env: {
      DEVBRIDGE_HOME: home,
      DEVBRIDGE_GITHUB_TOKEN: 'existing-installation-token',
      PATH: '',
    },
  }, {
    platform: 'win32',
    storeFactory: () => store(),
    pathInstaller: async ({ home: selected }) => {
      assert.equal(selected, path.resolve(home));
      return { persisted: true, changed: false, requiresNewShell: false };
    },
    clientFactory: (token) => { observedToken = token; return {}; },
    discover: async () => ({
      identity: { id: 42, login: 'owner' },
      repositories: [{ id: 1, full_name: 'owner/repo', private: true, archived: false, disabled: false, permissions: { push: true } }],
    }),
    releaseAuthority: async ({ home: selected }) => ({ keyring: path.join(selected, 'authority', 'ubuntu.gpg') }),
    authorityFactory: async ({ snapshot }) => ({ protocol: 'test-authority', snapshot }),
    canaryFactory: () => ({
      async status() { return { state: 'absent', blocked: false, complete: false, reason: null, preflight: { ready: true } }; },
      async run() { throw new Error('setup must never construct'); },
    }),
    now: () => new Date('2026-08-23T20:00:00Z'),
  });
  assert.equal(observedToken, 'existing-installation-token');
  assert.equal(result.readyForConstruction, true);
});
