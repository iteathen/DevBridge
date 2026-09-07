import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  runLinuxLifecycleAuthorityRefreshChild,
} from '../src/setup/linux-lifecycle-authority-refresh-child.js';
import { LINUX_LOCAL_IDENTITIES_PROTOCOL } from '../src/setup/linux-local-identities.js';
import { LINUX_LIFECYCLE_AUTHORITY_REFRESH_COMPOSITION_PROTOCOL } from '../src/setup/linux-lifecycle-authority-refresh-composition.js';
import { LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL } from '../src/setup/linux-provider-management-topology.js';
import { PROTECTED_AUTHORITY_RECONCILIATION_PROTOCOL } from '../src/setup/protected-authority-reconciliation.js';
import {
  createProtectedRefreshChildResult,
  normalizeProtectedRefreshChildRequest,
  PROTECTED_REFRESH_CHILD_REQUEST_PROTOCOL,
  PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL,
} from '../src/setup/protected-refresh-child-contract.js';

const CONTENT = 'a'.repeat(64);
const EXECUTABLE = 'b'.repeat(64);
const CAPABILITY = Object.freeze({ name: 'management', id: 120 });
const PRINCIPAL = Object.freeze({ name: 'alice', identityId: 1000, primaryCapabilityId: 1000 });
const STATE = '/home/alice/.devbridge/state';

function request(overrides = {}) {
  return Object.freeze({
    protocol: PROTECTED_REFRESH_CHILD_REQUEST_PROTOCOL,
    stateIdentity: STATE,
    principal: PRINCIPAL,
    requiredCapability: CAPABILITY,
    candidate: Object.freeze({ contentDigest: CONTENT, executableDigest: EXECUTABLE }),
    ...overrides,
  });
}

function topology(overrides = {}) {
  return Object.freeze({
    protocol: LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL,
    platform: 'linux',
    applicable: true,
    observable: true,
    exact: true,
    classification: 'group-only',
    route: 'segmented',
    selectedCapability: CAPABILITY,
    capabilities: Object.freeze([CAPABILITY]),
    subjects: Object.freeze([Object.freeze({ role: 'primary', policy: 'group-only', capability: CAPABILITY })]),
    reason: null,
    ...overrides,
  });
}

function identities(overrides = {}, capabilities = [CAPABILITY]) {
  return Object.freeze({
    protocol: LINUX_LOCAL_IDENTITIES_PROTOCOL,
    platform: 'linux',
    applicable: true,
    accounts: Object.freeze([Object.freeze({
      name: PRINCIPAL.name,
      record: Object.freeze({ name: PRINCIPAL.name, uid: PRINCIPAL.identityId, gid: PRINCIPAL.primaryCapabilityId, home: '/home/alice', shell: '/bin/bash' }),
      groupIds: Object.freeze([PRINCIPAL.primaryCapabilityId]),
    })]),
    groups: Object.freeze(capabilities.map((entry) => Object.freeze({
      name: entry.name,
      record: Object.freeze({ name: entry.name, gid: entry.id, members: Object.freeze([]) }),
    }))),
    ...overrides,
  });
}

function candidate(overrides = {}) {
  return Object.freeze({
    sourceSnapshot: Object.freeze({ digest: CONTENT, files: Object.freeze([]) }),
    node: Object.freeze({ size: 1, digest: EXECUTABLE }),
    evidence: Object.freeze({ packageDigest: CONTENT, nodeDigest: EXECUTABLE }),
    ...overrides,
  });
}

function fixture(overrides = {}) {
  const calls = [];
  const ports = {
    readPlatform: async () => 'linux',
    readEffectiveIdentityId: async () => 0,
    observeOrigin: async () => Object.freeze({ principal: PRINCIPAL }),
    observeTopology: async (value) => { calls.push(['topology', value]); return topology(); },
    observeIdentities: async (value) => { calls.push(['identities', value]); return identities(); },
    observeStateIdentity: async (value) => {
      calls.push(['state', value]);
      return Object.freeze({ protocol: 'devbridge/local-state-identity-v1', identity: STATE, ownerId: PRINCIPAL.identityId });
    },
    measureCandidate: async (value) => { calls.push(['candidate', value]); return candidate(); },
    createComposition: async (value) => {
      calls.push(['composition', value]);
      return Object.freeze({
        protocol: LINUX_LIFECYCLE_AUTHORITY_REFRESH_COMPOSITION_PROTOCOL,
        generation: value.candidatePlan.runtime.generation,
        mechanics: Object.freeze({}),
      });
    },
    refresh: async (value) => {
      calls.push(['refresh', value]);
      return Object.freeze({
        protocol: PROTECTED_AUTHORITY_RECONCILIATION_PROTOCOL,
        ready: true,
        changed: true,
        generation: value.candidateGeneration,
        recovered: false,
        blocker: null,
        transactionId: null,
      });
    },
    admitClaim: async () => true,
    invoke: async () => { throw new Error('not reached by the fixture'); },
    environment: Object.freeze({ LANG: 'C' }),
    ...overrides,
  };
  return Object.freeze({ calls, ports });
}

test('protected refresh child contract is exact, immutable, neutral, and has no compatibility shape', () => {
  const normalized = normalizeProtectedRefreshChildRequest(request());
  assert.deepEqual(normalized, request());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.principal), true);
  assert.equal(Object.isFrozen(normalized.requiredCapability), true);
  assert.equal(Object.isFrozen(normalized.candidate), true);
  for (const value of [
    { ...request(), legacy: true },
    { ...request(), protocol: 'devbridge/protected-refresh-child-request-v0' },
    { ...request(), principal: { ...PRINCIPAL, provider: 'foreign' } },
    { ...request(), requiredCapability: { ...CAPABILITY, id: 0 } },
    { ...request(), candidate: { contentDigest: CONTENT, executableDigest: 'x'.repeat(64) } },
  ]) assert.throws(() => normalizeProtectedRefreshChildRequest(value));

  assert.deepEqual(createProtectedRefreshChildResult({ ready: true, changed: false, generation: CONTENT, reason: null }), {
    protocol: PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL,
    ready: true,
    changed: false,
    generation: CONTENT,
    reason: null,
  });
  assert.deepEqual(createProtectedRefreshChildResult({ ready: false, changed: null, generation: null, reason: 'effect-indeterminate' }), {
    protocol: PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL,
    ready: false,
    changed: null,
    generation: null,
    reason: 'effect-indeterminate',
  });
  assert.throws(() => createProtectedRefreshChildResult({ ready: true, changed: null, generation: CONTENT, reason: null }));
  assert.throws(() => createProtectedRefreshChildResult({ ready: false, changed: false, generation: CONTENT, reason: 'failed' }));
});

test('elevated child re-observes local identity, topology, and candidate before attaching one refresh', async () => {
  const values = fixture();
  const result = await runLinuxLifecycleAuthorityRefreshChild(request(), values.ports);
  assert.equal(result.protocol, PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL);
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.match(result.generation, /^[0-9a-f]{64}$/u);
  assert.equal(result.reason, null);
  assert.deepEqual(values.calls.map(([name]) => name), ['topology', 'identities', 'state', 'candidate', 'composition', 'refresh']);

  const topologyRequest = values.calls[0][1];
  assert.deepEqual(Object.keys(topologyRequest).sort(), ['platform', 'signal']);
  assert.equal(topologyRequest.platform, 'linux');
  const identityRequest = values.calls[1][1];
  assert.deepEqual(identityRequest.accountNames, [PRINCIPAL.name]);
  assert.deepEqual(identityRequest.groupNames, [CAPABILITY.name]);
  assert.equal(identityRequest.platform, 'linux');
  assert.deepEqual(values.calls[2][1], { identity: STATE });
  const measured = values.calls[3][1];
  assert.equal(typeof measured.packageRoot, 'string');
  assert.equal(typeof measured.nodeExecutable, 'string');
  assert.equal(Object.values(request()).includes(measured.packageRoot), false);
  assert.equal(Object.values(request()).includes(measured.nodeExecutable), false);

  const composition = values.calls[4][1];
  assert.equal(composition.basePlan.stateDirectory, STATE);
  assert.equal(composition.basePlan.service.operator, PRINCIPAL.name);
  assert.equal(composition.basePlan.service.managementGroup, CAPABILITY.name);
  assert.equal(composition.basePlan.service.managementGroupId, CAPABILITY.id);
  assert.equal(composition.candidatePlan.runtimeEvidence.packageDigest, CONTENT);
  assert.equal(composition.candidatePlan.runtimeEvidence.nodeDigest, EXECUTABLE);
  assert.deepEqual(composition.candidate, candidate());
  assert.equal(composition.admitClaim, values.ports.admitClaim);
  assert.equal(composition.invoke, values.ports.invoke);
  assert.equal(composition.environment, values.ports.environment);
  assert.deepEqual(Object.keys(values.calls[5][1]).sort(), ['candidateGeneration', 'mechanics']);
});

test('child preserves distinct locally observed compatibility capability without granting either capability', async () => {
  const secondary = Object.freeze({ name: 'compatibility', id: 121 });
  const capabilities = Object.freeze([CAPABILITY, secondary]);
  const values = fixture();
  values.ports.observeTopology = async (value) => {
    values.calls.push(['topology', value]);
    return topology({
      capabilities,
      subjects: Object.freeze([
        Object.freeze({ role: 'primary', policy: 'group-only', capability: CAPABILITY }),
        Object.freeze({ role: 'compatibility', policy: 'group-only', capability: secondary }),
      ]),
    });
  };
  values.ports.observeIdentities = async (value) => {
    values.calls.push(['identities', value]);
    return identities({}, capabilities);
  };
  const result = await runLinuxLifecycleAuthorityRefreshChild(request(), values.ports);
  assert.equal(result.ready, true);
  assert.deepEqual(values.calls[1][1].groupNames, [CAPABILITY.name, secondary.name]);
  assert.equal(values.calls[4][1].basePlan.service.managementGroup, CAPABILITY.name);
  assert.equal(values.calls[4][1].basePlan.service.managementGroupId, CAPABILITY.id);
});

test('child pre-effect gates stop in dependency order without constructing refresh mechanics', async () => {
  const cases = [
    ['not-applicable', { readPlatform: async () => 'win32' }],
    ['authority-required', { readEffectiveIdentityId: async () => 1000 }],
    ['origin-invalid', { observeOrigin: async () => ({ widened: true }) }],
    ['origin-mismatch', { observeOrigin: async () => ({ principal: { ...PRINCIPAL, identityId: 1001 } }) }],
    ['capability-unavailable', { observeTopology: async () => topology({ classification: 'policy-backed', selectedCapability: null }) }],
    ['capability-unavailable', { observeTopology: async () => topology({ selectedCapability: { ...CAPABILITY, id: 121 } }) }],
    ['identity-unavailable', { observeIdentities: async () => identities({ accounts: [{ ...identities().accounts[0], groupIds: [1000, CAPABILITY.id] }] }) }],
    ['identity-unavailable', { observeIdentities: async () => identities({ groups: [{ name: CAPABILITY.name, record: { name: CAPABILITY.name, gid: 121, members: [] } }] }) }],
    ['state-untrusted', { observeStateIdentity: async () => ({ protocol: 'devbridge/local-state-identity-v1', identity: STATE, ownerId: 1001 }) }],
    ['state-untrusted', { observeStateIdentity: async () => ({ protocol: 'devbridge/local-state-identity-v1', identity: '/foreign/state', ownerId: PRINCIPAL.identityId }) }],
    ['candidate-unavailable', { measureCandidate: async () => candidate({ evidence: { packageDigest: 'c'.repeat(64), nodeDigest: EXECUTABLE } }) }],
  ];
  for (const [reason, replacement] of cases) {
    let constructed = false;
    const values = fixture({ ...replacement, createComposition: async () => { constructed = true; throw new Error('must not run'); } });
    const result = await runLinuxLifecycleAuthorityRefreshChild(request(), values.ports);
    assert.equal(result.ready, false, reason);
    assert.equal(result.changed, false, reason);
    assert.equal(result.generation, null, reason);
    assert.equal(result.reason, reason);
    assert.equal(constructed, false, reason);
  }
});

test('invalid and noncanonical state identities are refused before local observation', async () => {
  for (const raw of [
    { ...request(), unknown: true },
    { ...request(), stateIdentity: 'relative/state' },
    { ...request(), stateIdentity: '/home/alice/.devbridge/../state' },
    { ...request(), stateIdentity: '/home/alice/.devbridge/control' },
  ]) {
    const values = fixture();
    const result = await runLinuxLifecycleAuthorityRefreshChild(raw, values.ports);
    assert.equal(result.ready, false);
    assert.equal(result.reason, raw.unknown ? 'request-invalid' : 'state-invalid');
    assert.deepEqual(values.calls, []);
  }
});

test('post-admission failures never claim that no effect occurred and expose no raw error', async () => {
  const compositionFailure = fixture({ createComposition: async () => { throw new Error('/private/provider/path'); } });
  const first = await runLinuxLifecycleAuthorityRefreshChild(request(), compositionFailure.ports);
  assert.deepEqual(first, {
    protocol: PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL,
    ready: false,
    changed: null,
    generation: null,
    reason: 'composition-failed',
  });
  assert.equal(JSON.stringify(first).includes('/private'), false);

  const refreshFailure = fixture({ refresh: async () => { throw new Error('foreign provider details'); } });
  const second = await runLinuxLifecycleAuthorityRefreshChild(request(), refreshFailure.ports);
  assert.equal(second.ready, false);
  assert.equal(second.changed, null);
  assert.equal(second.reason, 'refresh-failed');
  assert.equal(JSON.stringify(second).includes('provider'), false);

  const notReady = fixture({ refresh: async () => ({
    protocol: PROTECTED_AUTHORITY_RECONCILIATION_PROTOCOL,
    ready: false,
    changed: true,
    generation: null,
    recovered: false,
    blocker: '/secret',
    transactionId: null,
  }) });
  const third = await runLinuxLifecycleAuthorityRefreshChild(request(), notReady.ports);
  assert.equal(third.ready, false);
  assert.equal(third.changed, true);
  assert.equal(third.reason, 'refresh-not-ready');
  assert.equal(JSON.stringify(third).includes('secret'), false);
});

test('dependency topology is closed before request observation', async () => {
  let observed = false;
  await assert.rejects(() => runLinuxLifecycleAuthorityRefreshChild(request(), {
    ...fixture().ports,
    observeOrigin: async () => { observed = true; return { principal: PRINCIPAL }; },
    arbitraryCommand: async () => {},
  }), /unknown field/u);
  assert.equal(observed, false);
});

test('state identity is re-observed through a narrow local evidence port before candidate measurement', async () => {
  let measured = false;
  const values = fixture({
    observeStateIdentity: async () => { throw new Error('/foreign/private/path'); },
    measureCandidate: async () => { measured = true; return candidate(); },
  });
  const result = await runLinuxLifecycleAuthorityRefreshChild(request(), values.ports);
  assert.equal(result.ready, false);
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'state-untrusted');
  assert.equal(measured, false);
  assert.equal(JSON.stringify(result).includes('/foreign'), false);
});

test('production state observer accepts only the exact ordinary-owned non-writable directory', {
  skip: process.platform !== 'linux' || process.getuid?.() === 0,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-refresh-state-'));
  const state = path.join(root, 'state');
  const writable = path.join(root, 'writable', 'state');
  const linked = path.join(root, 'linked', 'state');
  const principal = Object.freeze({ ...PRINCIPAL, identityId: process.getuid(), primaryCapabilityId: process.getgid() });
  try {
    await mkdir(state, { mode: 0o700 });
    await chmod(state, 0o700);
    await mkdir(path.dirname(writable));
    await mkdir(writable, { mode: 0o770 });
    await chmod(writable, 0o770);
    await mkdir(path.dirname(linked));
    await symlink(state, linked, 'dir');

    const createPorts = () => {
      const values = fixture({
        observeOrigin: async () => Object.freeze({ principal }),
        observeIdentities: async (value) => {
          values.calls.push(['identities', value]);
          return identities({
            accounts: Object.freeze([Object.freeze({
              name: principal.name,
              record: Object.freeze({ name: principal.name, uid: principal.identityId, gid: principal.primaryCapabilityId, home: root, shell: '/bin/sh' }),
              groupIds: Object.freeze([principal.primaryCapabilityId]),
            })]),
          });
        },
        observeStateIdentity: undefined,
      });
      return values;
    };

    const accepted = await runLinuxLifecycleAuthorityRefreshChild(request({ stateIdentity: state, principal }), createPorts().ports);
    assert.equal(accepted.ready, true);
    for (const stateIdentity of [writable, linked]) {
      const denied = await runLinuxLifecycleAuthorityRefreshChild(request({ stateIdentity, principal }), createPorts().ports);
      assert.equal(denied.ready, false);
      assert.equal(denied.changed, false);
      assert.equal(denied.reason, 'state-untrusted');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('neutral child contract imports no sibling and names no current topology', async () => {
  const contractSource = await readFile(new URL('../src/setup/protected-refresh-child-contract.js', import.meta.url), 'utf8');
  assert.equal(/^import\s/mu.test(contractSource), false);
  for (const identity of ['linux', 'windows', 'provider', 'libvirt', 'sudo', 'pkexec', 'systemd', 'service', 'profile', 'repository', 'virtual-machine']) {
    assert.equal(contractSource.toLowerCase().includes(identity), false, identity);
  }
  const compositionSource = await readFile(new URL('../src/setup/linux-lifecycle-authority-refresh-child.js', import.meta.url), 'utf8');
  assert.equal(compositionSource.includes('shell:'), false);
  assert.equal(compositionSource.includes('sudo'), false);
  assert.equal(compositionSource.includes('pkexec'), false);
  assert.equal(compositionSource.includes('child_process'), false);
  assert.equal(compositionSource.includes('request.provider'), false);
  assert.equal(compositionSource.includes('request.executable'), false);
  assert.equal(compositionSource.includes('request.environment'), false);
});
