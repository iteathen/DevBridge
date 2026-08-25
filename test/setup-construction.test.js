import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { formatSetupHandoff, runDevBridgeSetup } from '../src/app/setup.js';

function memoryStore(initial = null) {
  let value = initial;
  return {
    async get() { return structuredClone(value); },
    async set(_key, next) { value = structuredClone(next); },
  };
}

function fixture({ status, runResult } = {}) {
  const calls = { status: 0, run: 0 };
  const store = memoryStore();
  return {
    calls,
    deps: {
      platform: 'win32',
      now: () => new Date('2026-08-23T20:00:00Z'),
      storeFactory: () => store,
      pathInstaller: async ({ home }) => ({ protocol: 'test/path', command: path.join(home, 'bin', 'devbridge.cmd'), persisted: true, changed: false, requiresNewShell: false, temporaryCommand: null }),
      tokenResolver: async () => 'test-token',
      clientFactory: () => ({}),
      discover: async () => ({
        identity: { id: 42, login: 'owner' },
        repositories: [{ id: 1, full_name: 'owner/repo', private: false, archived: false, disabled: false, permissions: { push: true } }],
      }),
      prerequisiteReconciler: async () => ({ protocol: 'test/prerequisites', ready: true, blocker: null, changed: false, restartRequired: false, capabilities: {} }),
      lifecycleAuthorityReconciler: async ({ homeDirectory, stateDirectory, elevated }) => ({
        ok: true,
        changed: false,
        platform: 'win32',
        ready: true,
        elevationRequired: false,
        restartRequired: false,
        homeDirectory,
        stateDirectory,
        elevated,
        blocker: null,
        steps: [],
      }),
      releaseAuthority: async ({ home }) => ({ keyring: path.join(home, 'authority', 'ubuntu.gpg') }),
      authorityFactory: async ({ snapshot }) => ({ protocol: 'test/authority', snapshot }),
      canaryFactory: () => ({
        async status() {
          calls.status += 1;
          return status ?? { state: 'absent', blocked: false, complete: false, reason: null, preflight: { ready: true, connectivity: { control: 'system', addressing: 'automatic' } } };
        },
        async run() {
          calls.run += 1;
          if (runResult instanceof Error) throw runResult;
          return runResult ?? { state: 'waiting', phase: 'running', blocked: false, complete: false, reason: 'unattended installer is still running', preflight: { ready: true } };
        },
      }),
    },
  };
}

function home(name) {
  return path.join(os.tmpdir(), name);
}

test('plain setup remains read-only at the construction gate', async () => {
  const selected = fixture();
  const result = await runDevBridgeSetup({ home: home('db-setup-plain-construction-gate') }, selected.deps);
  assert.equal(result.readyForConstruction, true);
  assert.deepEqual(result.construction, { requested: false, attempted: false });
  assert.equal(selected.calls.status, 1);
  assert.equal(selected.calls.run, 0);
  const handoff = formatSetupHandoff(result);
  assert.match(handoff, /authorized by status gate, not started/u);
  assert.match(handoff, /host-managed DHCP; not claimed as DevBridge-owned/u);
});

test('plain setup reauthorizes a non-complete durable canary at the construction gate', async () => {
  const selected = fixture({
    status: { state: 'planned', phase: 'planned', blocked: false, complete: false, reason: null, preflight: { ready: true } },
  });
  const result = await runDevBridgeSetup({ home: home('db-setup-planned-construction-gate') }, selected.deps);
  assert.equal(result.readyForConstruction, true);
  assert.equal(result.phase, 'ready-for-construction');
  assert.deepEqual(result.construction, { requested: false, attempted: false });
  assert.equal(selected.calls.status, 1);
  assert.equal(selected.calls.run, 0);
  const handoff = formatSetupHandoff(result);
  assert.match(handoff, /DevBridge setup reached the construction gate/u);
  assert.match(handoff, /authorized to resume from durable planned frontier/u);
  assert.match(handoff, /performed no image or VM construction/u);
});

test('explicit construction crosses the canary run boundary only after an unblocked status', async () => {
  const selected = fixture();
  const result = await runDevBridgeSetup({ home: home('db-setup-explicit-construction'), construct: true }, selected.deps);
  assert.equal(result.blocked, false);
  assert.equal(result.readyForConstruction, false);
  assert.equal(result.phase, 'waiting');
  assert.deepEqual(result.construction, { requested: true, attempted: true });
  assert.equal(selected.calls.status, 1);
  assert.equal(selected.calls.run, 1);
  const handoff = formatSetupHandoff(result);
  assert.match(handoff, /durable frontier/u);
  assert.match(handoff, /devbridge setup --construct/u);
  assert.doesNotMatch(handoff, /not started/u);
});

test('explicit construction does not cross a blocked read-only gate', async () => {
  const selected = fixture({
    status: { state: 'blocked', blocked: true, complete: false, reason: 'Hyper-V provider is unavailable', preflight: { ready: false } },
  });
  const result = await runDevBridgeSetup({ home: home('db-setup-construct-blocked'), construct: true }, selected.deps);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.construction, { requested: true, attempted: false });
  assert.equal(selected.calls.status, 1);
  assert.equal(selected.calls.run, 0);
  assert.match(formatSetupHandoff(result), /DevBridge setup is blocked/u);
});

test('explicit construction resumes a non-complete durable canary state', async () => {
  const selected = fixture({
    status: { state: 'waiting', phase: 'active', blocked: false, complete: false, reason: 'SSH readiness is pending', preflight: { ready: true } },
    runResult: { state: 'completed', phase: 'completed', blocked: false, complete: true, reason: null, image: { generation: 'test' }, preflight: { ready: true } },
  });
  const result = await runDevBridgeSetup({ home: home('db-setup-construct-resume'), construct: true }, selected.deps);
  assert.equal(selected.calls.status, 1);
  assert.equal(selected.calls.run, 1);
  assert.equal(result.phase, 'image-complete');
  assert.deepEqual(result.construction, { requested: true, attempted: true });
  assert.match(formatSetupHandoff(result), /construction canary completed/u);
});

test('construction failures are reported without misclassifying them as read-only gate failures', async () => {
  const selected = fixture({ runResult: new Error('injected construction failure') });
  const result = await runDevBridgeSetup({ home: home('db-setup-construct-error'), construct: true }, selected.deps);
  assert.equal(result.blocked, true);
  assert.deepEqual(result.construction, { requested: true, attempted: true });
  assert.match(result.blocker, /physical production-image construction failed: injected construction failure/u);
  assert.equal(selected.calls.status, 1);
  assert.equal(selected.calls.run, 1);
  const handoff = formatSetupHandoff(result);
  assert.match(handoff, /physical image construction is blocked/u);
  assert.match(handoff, /Preserve the canary state/u);
});