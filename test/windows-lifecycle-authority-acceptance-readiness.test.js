import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileWindowsLifecycleAuthorityReadiness } from '../src/setup/windows-lifecycle-authority-readiness.js';

const STATE = 'C:\\Users\\Operator\\.devbridge\\state';
const AUTHORITY_DIRECTORY = 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\owner\\state';
const ACCEPTANCE_ENDPOINT = '\\\\.\\pipe\\devbridge-environment-owner-acceptance-v1';
const PLAN = Object.freeze({
  protocol: 'devbridge/windows-lifecycle-authority-plan-v1',
  stateDirectory: STATE,
  authorityDirectory: AUTHORITY_DIRECTORY,
  ownershipManifest: 'C:\\ProgramData\\DevBridge\\lifecycle-authority\\owner\\ownership.json',
  endpoints: Object.freeze({
    mutation: Object.freeze({ endpoint: '\\\\.\\pipe\\devbridge-environment-owner-mutation-v1' }),
    acceptance: Object.freeze({ endpoint: ACCEPTANCE_ENDPOINT }),
  }),
});

function serviceResult({ ready, service = 'ready', protectedState = 'ready', authorityIdentity = 'a'.repeat(32), blocker = null, changed = false } = {}) {
  return Object.freeze({
    protocol: 'devbridge/windows-lifecycle-authority-service-v1',
    platform: 'win32',
    ready,
    blocker,
    changed,
    authorityIdentity,
    service,
    protectedState,
  });
}

function unavailable() {
  return serviceResult({
    ready: false,
    service: 'unavailable',
    protectedState: 'unknown',
    blocker: 'bounded elevation required',
  });
}

function dependencies({ elevated = false, serviceReconciler, verifyService = async () => ({ ready: true }), verifyProtection = async () => ({ ready: true }), verifyAcceptance } = {}) {
  return {
    migrationSafety: async () => ({ ready: true }),
    legacyRuntimeMigration: async () => ({ ready: true }),
    inspectHost: async () => Object.freeze({
      elevated,
      operatorSid: 'S-1-5-21-1-2-3-1001',
      programData: 'C:\\ProgramData',
    }),
    clientFactory: () => Object.freeze({
      inspect: async () => ({ protocol: 'devbridge/environment-operator-v1' }),
    }),
    configurationClientFactory: () => Object.freeze({ inspect: async () => ({ ready: true }) }),
    verifyService,
    verifyProtection,
    verifyAcceptance,
    serviceReconciler,
  };
}

test('ordinary readiness runs bounded operational acceptance only after service and negative-capability proof', async () => {
  const calls = [];
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
  }, dependencies({
    serviceReconciler: async (_options, deps) => {
      await deps.inspectHost({});
      calls.push('service');
      await deps.probe(PLAN);
      calls.push('service-ready');
      return serviceResult({ ready: true });
    },
    verifyService: async () => { calls.push('service-proof'); return { ready: true }; },
    verifyProtection: async () => { calls.push('negative-proof'); return { ready: true }; },
    verifyAcceptance: async ({ authorityDirectory, endpoint }) => {
      calls.push('acceptance');
      assert.equal(authorityDirectory, AUTHORITY_DIRECTORY);
      assert.equal(endpoint, ACCEPTANCE_ENDPOINT);
      return { ready: true };
    },
  }));

  assert.equal(result.ready, true);
  assert.deepEqual(calls, ['service', 'service-proof', 'negative-proof', 'service-ready', 'acceptance']);
});

test('ordinary acceptance failure closes the construction gate without requesting elevation', async () => {
  let elevations = 0;
  let acceptanceCalls = 0;
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
    requestElevation: async () => { elevations += 1; return { completed: true }; },
  }, dependencies({
    serviceReconciler: async (_options, deps) => {
      await deps.inspectHost({});
      await deps.probe(PLAN);
      return serviceResult({ ready: true });
    },
    verifyAcceptance: async () => {
      acceptanceCalls += 1;
      throw new Error('raw fixture detail must not escape');
    },
  }));

  assert.equal(result.ready, false);
  assert.match(result.blocker, /ordinary operational acceptance proof/u);
  assert.doesNotMatch(result.blocker, /raw fixture detail/u);
  assert.equal(acceptanceCalls, 1);
  assert.equal(elevations, 0);
});

test('ordinary acceptance failure reports only bounded cleanup stages', async () => {
  const error = Object.assign(new Error('raw protected path'), {
    acceptanceStages: ['generation-inspect', 'vhdx-remove'],
  });
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
  }, dependencies({
    serviceReconciler: async (_options, deps) => {
      await deps.inspectHost({});
      await deps.probe(PLAN);
      return serviceResult({ ready: true });
    },
    verifyAcceptance: async () => { throw error; },
  }));
  assert.match(result.blocker, /Failed stages: generation-inspect,vhdx-remove/u);
  assert.doesNotMatch(result.blocker, /raw protected path/u);
});

test('stale ordinary authority accepts only after the one elevated child returns and parent re-proves service', async () => {
  let services = 0;
  let elevations = 0;
  let acceptanceCalls = 0;
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
    requestElevation: async () => { elevations += 1; return { completed: true, exitCode: 0 }; },
  }, dependencies({
    serviceReconciler: async (_options, deps) => {
      services += 1;
      await deps.inspectHost({});
      if (services === 1) return unavailable();
      await deps.probe(PLAN);
      return serviceResult({ ready: true, changed: true });
    },
    verifyAcceptance: async () => {
      acceptanceCalls += 1;
      return { ready: true };
    },
  }));

  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(services, 2);
  assert.equal(elevations, 1);
  assert.equal(acceptanceCalls, 1);
});

test('elevated child never runs the ordinary acceptance fixture', async () => {
  let acceptanceCalls = 0;
  const result = await reconcileWindowsLifecycleAuthorityReadiness({
    stateDirectory: STATE,
    platform: 'win32',
    mode: 'elevated-child',
  }, dependencies({
    elevated: true,
    serviceReconciler: async (_options, deps) => {
      await deps.inspectHost({});
      await deps.probe(PLAN);
      return serviceResult({ ready: true, changed: true });
    },
    verifyAcceptance: async () => {
      acceptanceCalls += 1;
      return { ready: true };
    },
  }));

  assert.equal(result.ready, true);
  assert.equal(acceptanceCalls, 0);
});
