import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileWindowsLifecycleAuthorityReadiness } from '../src/setup/windows-lifecycle-authority-readiness.js';

const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const PLAN = Object.freeze({
  stateDirectory: STATE,
  ownershipManifest: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\owner\\ownership.json',
  endpoints: Object.freeze({ mutation: Object.freeze({ endpoint: '\\\\.\\pipe\\devbridge-environment-owner-mutation-v1' }) }),
});

function readyService() {
  return Object.freeze({
    protocol: 'devbridge/windows-lifecycle-authority-service-v1',
    platform: 'win32',
    ready: true,
    blocker: null,
    changed: false,
    authorityIdentity: 'a'.repeat(32),
    service: 'ready',
    protectedState: 'ready',
  });
}

function host(elevated) {
  return Object.freeze({ elevated, operatorSid: 'S-1-5-21-1-2-3-1001', programData: 'C:\\ProgramData' });
}

function clientFactory(calls) {
  return (options) => {
    calls.push(['client', options]);
    return Object.freeze({
      async inspect() {
        calls.push(['inspect']);
        return Object.freeze({ protocol: 'devbridge/environment-operator-v1' });
      },
    });
  };
}

function portableMigration() {
  return Object.freeze({ protocol: 'migration', ready: true, blocker: null, classification: 'portable' });
}

test('non-Windows readiness leaves the Windows protection composition unattached', async () => {
  const calls = [];
  const expected = Object.freeze({ protocol: 'service', platform: 'linux', ready: true });
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: '/tmp/state', platform: 'linux' }, {
    migrationSafety: async () => { throw new Error('must remain unattached'); },
    serviceReconciler: async (options, dependencies) => {
      calls.push([options, dependencies]);
      return expected;
    },
    inspectHost: async () => { throw new Error('must remain unattached'); },
    clientFactory: () => { throw new Error('must remain unattached'); },
    verifyService: async () => { throw new Error('must remain unattached'); },
    verifyProtection: async () => { throw new Error('must remain unattached'); },
  });
  assert.equal(result, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], undefined);
});

test('unsafe legacy path-bound state stops before service inspection or provisioning', async () => {
  let serviceCalled = false;
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    migrationSafety: async () => Object.freeze({
      ready: false,
      classification: 'provider-aware-storage-migration-required',
      blocker: 'provider-aware migration required',
    }),
    serviceReconciler: async () => { serviceCalled = true; return readyService(); },
    inspectHost: async () => { throw new Error('must not inspect host after migration blocker'); },
    clientFactory: () => { throw new Error('must not create authority client after migration blocker'); },
    verifyService: async () => { throw new Error('must not verify service after migration blocker'); },
    verifyProtection: async () => { throw new Error('must not verify protection after migration blocker'); },
  });
  assert.equal(serviceCalled, false);
  assert.equal(result.ready, false);
  assert.equal(result.service, 'migration-required');
  assert.equal(result.protectedState, 'legacy-unprotected');
  assert.equal(result.blocker, 'provider-aware migration required');
});

test('provider-aware image adoption reaches the protected service path and accepts an already healthy exact generation', async () => {
  const calls = [];
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    migrationSafety: async () => Object.freeze({
      ready: false,
      classification: 'provider-aware-image-migration-required',
      blocker: 'provider-aware image adoption required',
    }),
    inspectHost: async () => { calls.push(['host']); return host(false); },
    clientFactory: clientFactory(calls),
    verifyService: async () => { calls.push(['service-proof']); return { ready: true }; },
    verifyProtection: async () => { calls.push(['protection']); return { ready: true }; },
    serviceReconciler: async (_options, dependencies) => {
      await dependencies.inspectHost({});
      await dependencies.probe(PLAN);
      return readyService();
    },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(calls.map((entry) => entry[0]), ['host', 'service-proof', 'client', 'inspect', 'protection']);
});

test('ordinary readiness requires SCM identity, read inspection, and negative-capability proof in that order', async () => {
  const calls = [];
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    migrationSafety: async () => portableMigration(),
    inspectHost: async () => { calls.push(['host']); return host(false); },
    clientFactory: clientFactory(calls),
    verifyService: async ({ operatorSid }) => { calls.push(['service-proof', operatorSid]); return { ready: true }; },
    verifyProtection: async ({ plan, elevated }) => { calls.push(['protection', elevated, plan]); return { ready: true, mode: 'ordinary-negative' }; },
    serviceReconciler: async (options, dependencies) => {
      assert.equal(options.stateDirectory, STATE);
      await dependencies.inspectHost({});
      await dependencies.probe(PLAN);
      return readyService();
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.service, 'ready');
  assert.deepEqual(calls.map((entry) => entry[0]), ['host', 'service-proof', 'client', 'inspect', 'protection']);
  assert.equal(calls[1][1], host(false).operatorSid);
  assert.equal(calls.at(-1)[1], false);
});

test('SCM identity failure blocks before any same-named read pipe can be trusted', async () => {
  const calls = [];
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    migrationSafety: async () => portableMigration(),
    inspectHost: async () => host(false),
    verifyService: async () => { calls.push('service-proof'); throw new Error('service mismatch'); },
    clientFactory: () => { calls.push('client'); throw new Error('fake pipe must not be consulted'); },
    verifyProtection: async () => { calls.push('protection'); throw new Error('must not run'); },
    serviceReconciler: async (_options, dependencies) => {
      await dependencies.inspectHost({});
      try { await dependencies.probe(PLAN); } catch {}
      return Object.freeze({ ...readyService(), ready: false, service: 'unavailable', protectedState: 'unknown', blocker: 'generic elevation boundary' });
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.blocker, 'generic elevation boundary');
  assert.deepEqual(calls, ['service-proof']);
});

test('elevated structural proof never publishes final readiness before ordinary re-entry', async () => {
  const calls = [];
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    migrationSafety: async () => portableMigration(),
    inspectHost: async () => host(true),
    clientFactory: clientFactory(calls),
    verifyService: async () => { calls.push(['service-proof']); return { ready: true }; },
    verifyProtection: async ({ elevated }) => { calls.push(['protection', elevated]); return { ready: true, mode: 'structural' }; },
    serviceReconciler: async (_options, dependencies) => {
      await dependencies.inspectHost({});
      await dependencies.probe(PLAN);
      return Object.freeze({ ...readyService(), changed: true });
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.changed, true);
  assert.equal(result.service, 'ready');
  assert.match(result.blocker, /non-elevated PowerShell/u);
  assert.deepEqual(calls.map((entry) => entry[0]), ['service-proof', 'client', 'inspect', 'protection']);
  assert.equal(calls.at(-1)[1], true);
});

test('ordinary protection failure is a bounded elevation blocker rather than readiness', async () => {
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    migrationSafety: async () => portableMigration(),
    inspectHost: async () => host(false),
    clientFactory: () => Object.freeze({ inspect: async () => ({ protocol: 'devbridge/environment-operator-v1' }) }),
    verifyService: async () => ({ ready: true }),
    verifyProtection: async () => { throw new Error('sensitive ACL detail must not escape'); },
    serviceReconciler: async (_options, dependencies) => {
      await dependencies.inspectHost({});
      try { await dependencies.probe(PLAN); } catch {}
      return Object.freeze({ ...readyService(), ready: false, service: 'unavailable', protectedState: 'unknown', blocker: 'generic elevation boundary' });
    },
  });
  assert.equal(result.ready, false);
  assert.match(result.blocker, /ordinary negative-capability proof/u);
  assert.doesNotMatch(result.blocker, /sensitive ACL detail/u);
});

test('elevated protection failure remains on the service-owned failed-health path', async () => {
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    migrationSafety: async () => portableMigration(),
    inspectHost: async () => host(true),
    clientFactory: () => Object.freeze({ inspect: async () => ({ protocol: 'devbridge/environment-operator-v1' }) }),
    verifyService: async () => ({ ready: true }),
    verifyProtection: async () => { throw new Error('protection mismatch'); },
    serviceReconciler: async (_options, dependencies) => {
      await dependencies.inspectHost({});
      try { await dependencies.probe(PLAN); } catch {
        return Object.freeze({ ...readyService(), ready: false, changed: true, service: 'stopped-after-failed-health', blocker: 'service-owned health stop' });
      }
      throw new Error('proof failure was not propagated through the service probe');
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.service, 'stopped-after-failed-health');
  assert.equal(result.blocker, 'service-owned health stop');
});
