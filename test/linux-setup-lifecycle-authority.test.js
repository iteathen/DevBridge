import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { reconcileSetupLifecycleAuthority } from '../src/app/setup-lifecycle-authority.js';
import {
  CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL,
} from '../src/setup/current-principal-observation.js';
import {
  reconcileLinuxSetupLifecycleAuthority,
  SETUP_LIFECYCLE_AUTHORITY_PROTOCOL,
} from '../src/setup/linux-setup-lifecycle-authority.js';
import { createProtectedReadinessObservation } from '../src/setup/protected-readiness-reconciliation.js';

const STATE = '/var/lib/devbridge-state';
const GENERATION = 'a'.repeat(64);
const SUBJECT = Object.freeze({ operation: 'refresh', evidence: Object.freeze({ digest: 'b'.repeat(64) }) });

function principal(overrides = {}) {
  return Object.freeze({
    protocol: CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL,
    ready: true,
    principal: Object.freeze({ name: 'local-user', identityId: 1001, primaryCapabilityId: 1002 }),
    reason: null,
    ...overrides,
  });
}

function ready() {
  return createProtectedReadinessObservation({ ready: true, subject: null, generation: GENERATION, reason: null });
}

function pending(subject = SUBJECT, reason = 'refresh-required') {
  return createProtectedReadinessObservation({ ready: false, subject, generation: GENERATION, reason });
}

function request(configuration = null) {
  return { stateIdentity: STATE, configuration };
}

function ports(overrides = {}) {
  return {
    observePrincipal: async () => principal(),
    observe: async () => ready(),
    attempt: async () => ({ forged: 'not-authority' }),
    createClient: () => ({ list: async () => [] }),
    ...overrides,
  };
}

test('exact-current Linux readiness performs no authentication or configuration effect', async () => {
  let attempts = 0;
  let observations = 0;
  let observedRequest = null;
  const result = await reconcileLinuxSetupLifecycleAuthority(request(), ports({
    observe: async (value) => { observations += 1; observedRequest = value; return ready(); },
    attempt: async () => { attempts += 1; },
  }));
  assert.deepEqual(observedRequest, { stateIdentity: STATE, principal: 'local-user' });
  assert.equal(observations, 1);
  assert.equal(attempts, 0);
  assert.deepEqual(result, {
    protocol: SETUP_LIFECYCLE_AUTHORITY_PROTOCOL,
    ready: true,
    blocker: null,
    changed: false,
    service: 'ready',
    protectedState: 'ready',
  });
});

test('repairable Linux readiness forwards one opaque subject and trusts only fresh observation', async () => {
  let observations = 0;
  let attempts = 0;
  let received = null;
  const result = await reconcileLinuxSetupLifecycleAuthority(request(), ports({
    observe: async () => (++observations === 1 ? pending() : ready()),
    attempt: async (value) => {
      attempts += 1;
      received = value;
      return { ready: true, output: 'forged' };
    },
  }));
  assert.equal(observations, 2);
  assert.equal(attempts, 1);
  assert.equal(received.subject, SUBJECT);
  assert.deepEqual(Object.keys(received), ['subject']);
  assert.equal(result.ready, true);
});

test('failed authentication still re-observes once and never retries or leaks diagnostics', async () => {
  let observations = 0;
  let attempts = 0;
  const result = await reconcileLinuxSetupLifecycleAuthority(request(), ports({
    observe: async () => {
      observations += 1;
      return observations === 1 ? pending() : pending(Object.freeze({ next: true }), 'still-not-ready');
    },
    attempt: async () => { attempts += 1; throw new Error('/private/sudo'); },
  }));
  assert.equal(observations, 2);
  assert.equal(attempts, 1);
  assert.equal(result.ready, false);
  assert.match(result.blocker, /one local authentication attempt/u);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('sudo'), false);
  assert.equal(Object.hasOwn(result, 'principal'), false);
  assert.equal(Object.hasOwn(result, 'subject'), false);
});

test('invalid principal evidence stops before readiness or authentication', async () => {
  for (const observation of [
    { ...principal(), widened: true },
    Object.freeze({ protocol: CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL, ready: false, principal: null, reason: 'identity-mismatch' }),
  ]) {
    let readiness = 0;
    let attempts = 0;
    const result = await reconcileLinuxSetupLifecycleAuthority(request(), ports({
      observePrincipal: async () => observation,
      observe: async () => { readiness += 1; return ready(); },
      attempt: async () => { attempts += 1; },
    }));
    assert.equal(result.ready, false);
    assert.equal(readiness, 0);
    assert.equal(attempts, 0);
  }
});

test('accepted configuration reconciles once and must verify through a fresh client', async () => {
  let inspections = 0;
  let reconciliations = 0;
  const clients = [];
  const configuration = {
    async inspect({ client }) {
      inspections += 1;
      clients.push(client.sequence);
      return { ready: inspections === 2, changed: false, blocker: inspections === 2 ? null : 'not-current' };
    },
    async reconcile() {
      reconciliations += 1;
      return { ready: true, changed: true, blocker: null };
    },
  };
  let clientSequence = 0;
  const result = await reconcileLinuxSetupLifecycleAuthority(request(configuration), ports({
    createClient: ({ stateIdentity }) => ({ stateIdentity, sequence: ++clientSequence }),
  }));
  assert.equal(inspections, 2);
  assert.equal(reconciliations, 1);
  assert.deepEqual(clients, [1, 2]);
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
});

test('configuration failure remains path-free and cannot be promoted to readiness', async () => {
  const cases = [
    {
      inspect: async () => ({ ready: true, changed: true, blocker: null }),
      reconcile: async () => { throw new Error('must not reconcile invalid observation'); },
    },
    {
      inspect: async () => ({ ready: false, changed: false, blocker: '/private/not-current' }),
      reconcile: async () => { throw new Error('/private/failure'); },
    },
    {
      inspect: async () => ({ ready: false, changed: false, blocker: '/private/not-current' }),
      reconcile: async () => ({ ready: true, changed: true, blocker: null }),
    },
  ];
  for (const [index, configuration] of cases.entries()) {
    let inspections = 0;
    const selected = index < 2 ? configuration : {
      ...configuration,
      inspect: async () => {
        inspections += 1;
        return inspections === 1
          ? { ready: false, changed: false, blocker: '/private/not-current' }
          : { ready: false, changed: false, blocker: '/private/still-not-current' };
      },
    };
    const result = await reconcileLinuxSetupLifecycleAuthority(request(selected), ports());
    assert.equal(result.ready, false);
    assert.match(result.blocker, /did not verify through protected authority/u);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('setup selector projects only the adapter-local request and fails closed off supported platforms', async () => {
  const full = {
    stateDirectory: STATE,
    platform: 'linux',
    invoke: async () => null,
    environment: { SECRET: 'not-forwarded' },
    configuration: null,
    requestElevation: null,
  };
  let selectedPlatform = null;
  let received = null;
  const expected = Object.freeze({ ready: true });
  const result = await reconcileSetupLifecycleAuthority(full, {
    select: async (platform) => {
      selectedPlatform = platform;
      return {
        project: (value) => ({ local: value.stateDirectory }),
        reconcile: async (value) => { received = value; return expected; },
      };
    },
  });
  assert.equal(selectedPlatform, 'linux');
  assert.deepEqual(received, { local: STATE });
  assert.equal(result, expected);

  const unsupported = await reconcileSetupLifecycleAuthority({ ...full, platform: 'other' });
  assert.deepEqual(unsupported, {
    protocol: SETUP_LIFECYCLE_AUTHORITY_PROTOCOL,
    ready: false,
    blocker: 'Protected lifecycle authority is unavailable on this host platform.',
    changed: false,
    service: 'unavailable',
    protectedState: 'unknown',
  });
});

test('setup lifecycle contracts reject topology-shaped extensions and contain no fallback implementation', async () => {
  await assert.rejects(reconcileLinuxSetupLifecycleAuthority({ ...request(), executable: '/bin/foreign' }, ports()), /unknown field/u);
  await assert.rejects(reconcileLinuxSetupLifecycleAuthority(request(), { ...ports(), fallback: async () => null }), /unknown field/u);
  await assert.rejects(reconcileSetupLifecycleAuthority({
    stateDirectory: STATE,
    platform: 'linux',
    invoke: async () => null,
    environment: {},
    configuration: null,
    requestElevation: null,
    provider: 'foreign',
  }), /unknown field/u);

  const source = (await readFile(new URL('../src/setup/linux-setup-lifecycle-authority.js', import.meta.url), 'utf8')).toLowerCase();
  for (const identity of ['pkexec', 'askpass', 'password', 'shell:', 'provider', 'repository', 'virtual-machine']) {
    assert.equal(source.includes(identity), false, identity);
  }
});
