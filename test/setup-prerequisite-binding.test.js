import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { runDevBridgeSetup } from '../src/app/setup.js';
import { projectSetupStatus } from '../src/setup/status-operation.js';

function memoryStore() {
  let value = null;
  return {
    async get() { return structuredClone(value); },
    async set(_key, next) { value = structuredClone(next); },
  };
}

const VERIFIER = 'C:\\Program Files\\GnuPG\\bin\\gpgv.exe';

test('setup carries the local signature-verifier binding through release verification and physical status without remote projection', async () => {
  const store = memoryStore();
  let releaseBinding = null;
  let canaryBinding = null;
  let canaryRun = 0;

  const result = await runDevBridgeSetup({
    home: path.join(os.tmpdir(), 'devbridge-setup-prerequisite-binding'),
    env: {},
  }, {
    platform: 'win32',
    storeFactory: () => store,
    pathInstaller: async () => ({ persisted: true, changed: false, requiresNewShell: false, temporaryCommand: null }),
    tokenResolver: async () => 'token',
    clientFactory: () => ({}),
    discover: async () => ({ identity: { id: 1, login: 'owner' }, repositories: [] }),
    selectRepositories: () => ({ discoveredCount: 0, eligibleCount: 0, selectedCount: 0, needsSelection: false, selected: [], excluded: [] }),
    prerequisiteReconciler: async () => ({
      protocol: 'devbridge/setup-prerequisites-v1',
      platform: 'win32',
      ready: true,
      blocker: null,
      changed: true,
      restartRequired: false,
      capabilities: { gpgv: true, opensshClient: true },
      local: { signatureVerifierExecutable: VERIFIER },
    }),
    releaseAuthority: async ({ signatureVerifierExecutable }) => {
      releaseBinding = signatureVerifierExecutable;
      return { keyring: path.join(os.tmpdir(), 'ubuntu-keyring.gpg') };
    },
    authorityFactory: async () => ({ protocol: 'test/authority' }),
    canaryFactory: (_config, { signatureVerifierExecutable }) => {
      canaryBinding = signatureVerifierExecutable;
      return {
        async status() { return { state: 'absent', blocked: false, complete: false, reason: null, preflight: { ready: true } }; },
        async run() { canaryRun += 1; throw new Error('setup must not construct'); },
      };
    },
  });

  assert.equal(result.readyForConstruction, true);
  assert.equal(releaseBinding, VERIFIER);
  assert.equal(canaryBinding, VERIFIER);
  assert.equal(canaryRun, 0);

  const projected = projectSetupStatus(result);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes(VERIFIER), false);
  assert.equal(serialized.includes('signatureVerifierExecutable'), false);
  assert.deepEqual(projected.prerequisites.capabilities, { gpgv: true, opensshClient: true });
});
