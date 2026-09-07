import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL,
} from '../src/setup/current-principal-capabilities.js';
import {
  bindLinuxLifecycleAuthorityRuntime,
  createLinuxLifecycleAuthorityPlan,
} from '../src/setup/linux-lifecycle-authority.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority-inspection.js';
import {
  observeLinuxLifecycleAuthorityReadiness,
} from '../src/setup/linux-lifecycle-authority-readiness.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_SELECTION_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority-plan-selection.js';
import { LINUX_LOCAL_IDENTITIES_PROTOCOL } from '../src/setup/linux-local-identities.js';
import { LINUX_LOCAL_STATE_IDENTITY_PROTOCOL } from '../src/setup/linux-local-state-identity.js';
import { ORDINARY_ACCESS_BOUNDARY_PROTOCOL } from '../src/setup/linux-ordinary-access-boundary.js';
import { LINUX_SERVICE_OBSERVATION_PROTOCOL } from '../src/setup/linux-service-observation.js';
import {
  PROTECTED_READINESS_OBSERVATION_PROTOCOL,
} from '../src/setup/protected-readiness-reconciliation.js';
import {
  PROTECTED_REFRESH_CHILD_REQUEST_PROTOCOL,
} from '../src/setup/protected-refresh-child-contract.js';

const STATE = '/home/alice/.devbridge/state';
const PRINCIPAL = 'alice';
const UID = 1000;
const GID = 1000;
const SERVICE_UID = 995;
const READ_GID = 994;
const COORDINATION_GID = 993;
const MANAGEMENT = Object.freeze({ name: 'provider-control', id: 108 });
const CONTENT = 'a'.repeat(64);
const EXECUTABLE = 'b'.repeat(64);
const FILESYSTEM_KEYS = Object.freeze([
  'unit', 'endpointDefinition', 'protectedRoot', 'authorityState', 'ownershipManifest', 'generationsDirectory',
  'generationDirectory', 'binDirectory', 'packageDirectory', 'generationManifest', 'nodeExecutable', 'packageManifest',
  'serviceEntry', 'endpointsParent', 'runRoot', 'governanceDirectory', 'governanceLock', 'readDirectory',
  'mutationDirectory', 'readEndpoint', 'mutationEndpoint', 'configurationRoot', 'configurationEndpointDirectory',
  'configurationHandoffDirectory', 'configurationEndpoint', 'activityRoot', 'activityEndpointDirectory',
  'activityHandoffDirectory', 'activityEndpoint',
]);

function basePlan() {
  return createLinuxLifecycleAuthorityPlan({ stateDirectory: STATE, operatorName: PRINCIPAL, managementGroup: MANAGEMENT });
}

function candidate(overrides = {}) {
  return Object.freeze({
    sourceSnapshot: Object.freeze({ digest: CONTENT, files: Object.freeze([]) }),
    node: Object.freeze({ size: 1, digest: EXECUTABLE }),
    evidence: Object.freeze({ packageDigest: CONTENT, nodeDigest: EXECUTABLE }),
    ...overrides,
  });
}

function identities(plan) {
  return Object.freeze({
    protocol: LINUX_LOCAL_IDENTITIES_PROTOCOL,
    platform: 'linux',
    applicable: true,
    accounts: Object.freeze([
      Object.freeze({
        name: PRINCIPAL,
        record: Object.freeze({ name: PRINCIPAL, uid: UID, gid: GID, home: '/home/alice', shell: '/bin/bash' }),
        groupIds: Object.freeze([GID, READ_GID, COORDINATION_GID]),
      }),
      Object.freeze({
        name: plan.service.user,
        record: Object.freeze({ name: plan.service.user, uid: SERVICE_UID, gid: READ_GID, home: '/nonexistent', shell: '/usr/sbin/nologin' }),
        groupIds: Object.freeze([READ_GID, COORDINATION_GID, MANAGEMENT.id]),
      }),
    ]),
    groups: Object.freeze([
      Object.freeze({ name: 'root', record: Object.freeze({ name: 'root', gid: 0, members: Object.freeze([]) }) }),
      Object.freeze({ name: plan.service.readGroup, record: Object.freeze({ name: plan.service.readGroup, gid: READ_GID, members: Object.freeze([PRINCIPAL]) }) }),
      Object.freeze({ name: plan.service.coordinationGroup, record: Object.freeze({ name: plan.service.coordinationGroup, gid: COORDINATION_GID, members: Object.freeze([PRINCIPAL, plan.service.user]) }) }),
      Object.freeze({ name: MANAGEMENT.name, record: Object.freeze({ name: MANAGEMENT.name, gid: MANAGEMENT.id, members: Object.freeze([plan.service.user]) }) }),
    ]),
  });
}

function current(overrides = {}) {
  return Object.freeze({
    protocol: CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL,
    platform: 'linux',
    applicable: true,
    identityIds: Object.freeze([UID, UID]),
    primaryCapabilityIds: Object.freeze([GID, GID]),
    capabilityIds: Object.freeze([GID, READ_GID, COORDINATION_GID]),
    ...overrides,
  });
}

function filesystem() {
  return Object.freeze(Object.fromEntries(FILESYSTEM_KEYS.map((name) => [name, Object.freeze({
    exists: true,
    kind: true,
    owner: true,
    group: true,
    mode: true,
    observedMode: name === 'authorityState' ? 0o700 : 0o755,
  })])));
}

function inspection(plan, overrides = {}) {
  return Object.freeze({
    protocol: LINUX_LIFECYCLE_AUTHORITY_INSPECTION_PROTOCOL,
    platform: 'linux',
    applicable: true,
    authorityIdentity: plan.authorityIdentity,
    identities: Object.freeze({
      service: true,
      operator: true,
      serviceUid: SERVICE_UID,
      operatorUid: UID,
      readGid: READ_GID,
      coordinationGid: COORDINATION_GID,
      managementGid: MANAGEMENT.id,
      rootGid: 0,
      serviceGroupIds: Object.freeze([READ_GID, COORDINATION_GID, MANAGEMENT.id]),
    }),
    ownership: Object.freeze({ exists: true, exact: true, record: Object.freeze({ exact: true }) }),
    generation: Object.freeze({ exists: true, exact: true, record: Object.freeze({ exact: true }) }),
    topology: Object.freeze({ definitionExact: true }),
    service: Object.freeze({
      protocol: LINUX_SERVICE_OBSERVATION_PROTOCOL,
      platform: 'linux',
      applicable: true,
      observable: true,
      exists: true,
      reason: null,
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      mainPid: 42,
      fragmentPath: plan.service.unitPath,
      user: plan.service.user,
      group: plan.service.readGroup,
      supplementaryGroups: Object.freeze([plan.service.coordinationGroup, String(MANAGEMENT.id)]),
      type: 'exec',
      unitFileState: 'enabled',
      needsReload: false,
      dropIns: false,
      definitionCurrent: true,
      unitExact: true,
      identity: true,
      groups: true,
      fragment: true,
      startBoundary: true,
      enabled: true,
    }),
    process: Object.freeze({
      observable: true,
      identity: true,
      groups: true,
      executable: true,
      uids: Object.freeze([SERVICE_UID, SERVICE_UID, SERVICE_UID, SERVICE_UID]),
      gids: Object.freeze([READ_GID, READ_GID, READ_GID, READ_GID]),
      groupIds: Object.freeze([READ_GID, COORDINATION_GID, MANAGEMENT.id]),
    }),
    filesystem: filesystem(),
    runtime: Object.freeze({ ready: true, exact: true, generation: plan.runtime.generation }),
    ...overrides,
  });
}

function fixture(overrides = {}) {
  const base = basePlan();
  let bound = null;
  const calls = [];
  const ports = {
    select: async (value) => {
      calls.push(['select', value]);
      return Object.freeze({
        protocol: LINUX_LIFECYCLE_AUTHORITY_PLAN_SELECTION_PROTOCOL,
        platform: 'linux',
        applicable: true,
        ready: true,
        reason: null,
        plan: base,
      });
    },
    measure: async (value) => { calls.push(['measure', value]); return candidate(); },
    bind: (plan, evidence) => { calls.push(['bind', evidence]); bound = bindLinuxLifecycleAuthorityRuntime(plan, evidence); return bound; },
    observeIdentities: async (value) => { calls.push(['identities', value]); return identities(bound); },
    observeCurrent: async (value) => { calls.push(['current', value]); return current(); },
    observeState: async (value) => {
      calls.push(['state', value]);
      return Object.freeze({ protocol: LINUX_LOCAL_STATE_IDENTITY_PROTOCOL, identity: STATE, ownerId: UID });
    },
    inspect: async (value) => { calls.push(['inspect', value]); return inspection(bound); },
    observeBoundary: async (value) => {
      calls.push(['boundary', value]);
      return Object.freeze({ protocol: ORDINARY_ACCESS_BOUNDARY_PROTOCOL, platform: 'linux', applicable: true, ready: true, reason: null });
    },
    probe: async (value) => { calls.push(['probe', value]); return Object.freeze({ protocol: 'devbridge/environment-operator-v1' }); },
    ...overrides,
  };
  return Object.freeze({ calls, ports, base, get bound() { return bound; } });
}

test('ordinary Linux readiness composes exact structural, negative-access, and protocol evidence', async () => {
  const values = fixture();
  const observed = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, values.ports);
  assert.equal(observed.protocol, PROTECTED_READINESS_OBSERVATION_PROTOCOL);
  assert.equal(observed.ready, true);
  assert.equal(observed.subject, null);
  assert.equal(observed.generation, values.bound.runtime.generation);
  assert.deepEqual(values.calls.map(([name]) => name), ['select', 'measure', 'bind', 'identities', 'current', 'state', 'inspect', 'boundary', 'probe']);
  assert.deepEqual(values.calls.find(([name]) => name === 'boundary')[1], { identity: values.bound.authorityDirectory, principalId: UID });
  const measured = values.calls.find(([name]) => name === 'measure')[1];
  assert.equal(typeof measured.packageRoot, 'string');
  assert.equal(typeof measured.nodeExecutable, 'string');
  assert.equal(Object.values({ stateIdentity: STATE, principal: PRINCIPAL }).includes(measured.packageRoot), false);
});

test('incomplete installed evidence returns the unchanged protected child subject without invoking later probes', async () => {
  const values = fixture({ inspect: async () => { throw new Error('not installed'); } });
  const observed = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, values.ports);
  assert.equal(observed.ready, false);
  assert.equal(observed.reason, 'refresh-required');
  assert.equal(observed.subject.protocol, PROTECTED_REFRESH_CHILD_REQUEST_PROTOCOL);
  assert.deepEqual(observed.subject.principal, { name: PRINCIPAL, identityId: UID, primaryCapabilityId: GID });
  assert.deepEqual(observed.subject.requiredCapability, MANAGEMENT);
  assert.deepEqual(observed.subject.candidate, { contentDigest: CONTENT, executableDigest: EXECUTABLE });
  assert.equal(values.calls.some(([name]) => name === 'boundary'), false);
  assert.equal(values.calls.some(([name]) => name === 'probe'), false);
});

test('widened or stale inspection cannot become ready', async () => {
  const values = fixture({
    inspect: async ({ plan }) => ({ ...inspection(plan), foreign: true }),
  });
  const widened = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, values.ports);
  assert.equal(widened.ready, false);
  assert.equal(widened.reason, 'refresh-required');
  assert.equal(widened.subject.protocol, PROTECTED_REFRESH_CHILD_REQUEST_PROTOCOL);

  const staleValues = fixture({
    inspect: async ({ plan }) => inspection(plan, { runtime: Object.freeze({ ready: true, exact: true, generation: 'f'.repeat(64) }) }),
  });
  const stale = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, staleValues.ports);
  assert.equal(stale.ready, false);
  assert.equal(stale.reason, 'refresh-required');
});

test('principal drift and malformed candidate stop before producing a protected subject', async () => {
  const drift = fixture({ observeCurrent: async () => current({ identityIds: Object.freeze([UID, 0]) }) });
  const changed = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, drift.ports);
  assert.equal(changed.ready, false);
  assert.equal(changed.reason, 'identity-unavailable');
  assert.equal(changed.subject, null);

  const inherited = fixture({ observeCurrent: async () => current({ capabilityIds: Object.freeze([GID, MANAGEMENT.id]) }) });
  const privileged = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, inherited.ports);
  assert.equal(privileged.ready, false);
  assert.equal(privileged.reason, 'identity-unavailable');
  assert.equal(privileged.subject, null);

  const stateDrift = fixture({
    observeState: async () => Object.freeze({ protocol: LINUX_LOCAL_STATE_IDENTITY_PROTOCOL, identity: STATE, ownerId: 2000 }),
  });
  const displaced = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, stateDrift.ports);
  assert.equal(displaced.ready, false);
  assert.equal(displaced.reason, 'identity-unavailable');
  assert.equal(displaced.subject, null);

  const malformed = fixture({ measure: async () => ({ ...candidate(), legacy: true }) });
  const rejected = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, malformed.ports);
  assert.equal(rejected.ready, false);
  assert.equal(rejected.reason, 'candidate-unavailable');
  assert.equal(rejected.subject, null);
});

test('unexpected ordinary direct access closes readiness without requesting protected work', async () => {
  const values = fixture({
    observeBoundary: async () => Object.freeze({
      protocol: ORDINARY_ACCESS_BOUNDARY_PROTOCOL,
      platform: 'linux',
      applicable: true,
      ready: false,
      reason: 'direct-access-present',
    }),
  });
  const observed = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, values.ports);
  assert.equal(observed.ready, false);
  assert.equal(observed.reason, 'access-boundary-unverified');
  assert.equal(observed.subject, null);
});

test('failed protected health is refresh-required but never accepted from structural evidence alone', async () => {
  const values = fixture({ probe: async () => { throw new Error('endpoint unavailable'); } });
  const observed = await observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, values.ports);
  assert.equal(observed.ready, false);
  assert.equal(observed.reason, 'refresh-required');
  assert.equal(observed.subject.protocol, PROTECTED_REFRESH_CHILD_REQUEST_PROTOCOL);
});

test('readiness ports reject widening and modules retain isolated ownership', async () => {
  const values = fixture();
  await assert.rejects(() => observeLinuxLifecycleAuthorityReadiness({ stateIdentity: STATE, principal: PRINCIPAL }, { ...values.ports, executable: '/bin/foreign' }));
  const policy = await readFile(fileURLToPath(new URL('../src/setup/protected-readiness-reconciliation.js', import.meta.url)), 'utf8');
  assert.equal(/^import\s/mu.test(policy), false);
  for (const forbidden of ['linux', 'sudo', 'pkexec', 'setup', 'service', 'provider', 'repository', 'child']) {
    assert.equal(policy.toLowerCase().includes(forbidden), false, `neutral policy leaked ${forbidden}`);
  }
  const boundary = await readFile(fileURLToPath(new URL('../src/setup/linux-ordinary-access-boundary.js', import.meta.url)), 'utf8');
  for (const forbidden of ['sudo', 'pkexec', 'systemctl', 'provider', 'service', 'repository']) {
    assert.equal(boundary.toLowerCase().includes(forbidden), false, `access leaf leaked ${forbidden}`);
  }
  const state = await readFile(fileURLToPath(new URL('../src/setup/linux-local-state-identity.js', import.meta.url)), 'utf8');
  for (const forbidden of ['sudo', 'pkexec', 'provider', 'service', 'repository']) {
    assert.equal(state.toLowerCase().includes(forbidden), false, `state identity leaf leaked ${forbidden}`);
  }
  const readiness = await readFile(fileURLToPath(new URL('../src/setup/linux-lifecycle-authority-readiness.js', import.meta.url)), 'utf8');
  for (const forbidden of ['sudo', 'pkexec', 'runlinuxlifecycleauthorityrefreshchild', "'../app/setup.js'", "'../cli.js'"]) {
    assert.equal(readiness.toLowerCase().includes(forbidden), false, `readiness root attached ${forbidden}`);
  }
});
