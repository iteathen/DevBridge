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

test('non-Windows readiness leaves the Windows protection composition unattached', async () => {
  const calls = [];
  const expected = Object.freeze({ protocol: 'service', platform: 'linux', ready: true });
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: '/tmp/state', platform: 'linux' }, {
    serviceReconciler: async (options, dependencies) => {
      calls.push([options, dependencies]);
      return expected;
    },
    inspectHost: async () => { throw new Error('must remain unattached'); },
    clientFactory: () => { throw new Error('must remain unattached'); },
    verifyProtection: async () => { throw new Error('must remain unattached'); },
  });
  assert.equal(result, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], undefined);
});

test('ordinary readiness requires read inspection plus negative-capability protection proof', async () => {
  const calls = [];
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    inspectHost: async () => { calls.push(['host']); return host(false); },
    clientFactory: clientFactory(calls),
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
  assert.deepEqual(calls.map((entry) => entry[0]), ['host', 'client', 'inspect', 'protection']);
  assert.equal(calls.at(-1)[1], false);
});

test('elevated structural proof never publishes final readiness before ordinary re-entry', async () => {
  const calls = [];
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    inspectHost: async () => host(true),
    clientFactory: clientFactory(calls),
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
  assert.equal(calls.at(-1)[1], true);
});

test('ordinary protection failure is a bounded elevation blocker rather than readiness', async () => {
  const result = await reconcileWindowsLifecycleAuthorityReadiness({ stateDirectory: STATE, platform: 'win32', invoke: async () => {} }, {
    inspectHost: async () => host(false),
    clientFactory: () => Object.freeze({ inspect: async () => ({ protocol: 'devbridge/environment-operator-v1' }) }),
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
    inspectHost: async () => host(true),
    clientFactory: () => Object.freeze({ inspect: async () => ({ protocol: 'devbridge/environment-operator-v1' }) }),
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
