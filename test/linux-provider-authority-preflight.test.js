import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  assessCapabilitySeparation,
  CAPABILITY_SEPARATION_PROTOCOL,
} from '../src/setup/capability-separation.js';
import {
  CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL,
  observeCurrentPrincipalCapabilities,
} from '../src/setup/current-principal-capabilities.js';
import { LINUX_LOCAL_IDENTITIES_PROTOCOL } from '../src/setup/linux-local-identities.js';
import {
  LINUX_PROVIDER_AUTHORITY_PREFLIGHT_PROTOCOL,
  observeLinuxProviderAuthorityPreflight,
} from '../src/setup/linux-provider-authority-preflight.js';
import { LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL } from '../src/setup/linux-provider-management-topology.js';

const CAPABILITIES = Object.freeze([
  Object.freeze({ name: 'primary_control', id: 980 }),
  Object.freeze({ name: 'compat_control', id: 981 }),
]);

function topology(overrides = {}) {
  return Object.freeze({
    protocol: LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL,
    platform: 'linux',
    applicable: true,
    observable: true,
    exact: true,
    classification: 'group-only',
    route: 'segmented',
    selectedCapability: CAPABILITIES[0],
    capabilities: CAPABILITIES,
    subjects: Object.freeze([]),
    reason: null,
    ...overrides,
  });
}

function identities({ groupIds = [27, 1000], capabilities = CAPABILITIES, accountOverrides = {}, groupOverrides = new Map() } = {}) {
  return Object.freeze({
    protocol: LINUX_LOCAL_IDENTITIES_PROTOCOL,
    platform: 'linux',
    applicable: true,
    accounts: Object.freeze([Object.freeze({
      name: 'alice',
      record: Object.freeze({ name: 'alice', uid: 1000, gid: 1000, home: '/home/alice', shell: '/bin/bash', ...accountOverrides }),
      groupIds: Object.freeze(groupIds),
    })]),
    groups: Object.freeze(capabilities.map((entry) => Object.freeze({
      name: entry.name,
      record: Object.freeze({ name: entry.name, gid: groupOverrides.get(entry.name) ?? entry.id, members: Object.freeze([]) }),
    }))),
  });
}

function current(overrides = {}) {
  return Object.freeze({
    protocol: CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL,
    platform: 'linux',
    applicable: true,
    identityIds: Object.freeze([1000, 1000]),
    primaryCapabilityIds: Object.freeze([1000, 1000]),
    capabilityIds: Object.freeze([27, 1000]),
    ...overrides,
  });
}

function fixture(overrides = {}) {
  const calls = [];
  const values = { topology: topology(), identities: identities(), current: current(), ...overrides };
  return Object.freeze({
    calls,
    ports: Object.freeze({
      async inspectRoute(request) { calls.push(['route', request]); return values.topology; },
      async inspectRecords(request) { calls.push(['records', request]); return values.identities; },
      async inspectCurrent(request) { calls.push(['current', request]); return values.current; },
      assess(request) { calls.push(['assess', request]); return assessCapabilitySeparation(request); },
    }),
  });
}

function principal(overrides = {}) {
  return Object.freeze({
    identityId: 1000,
    primaryCapabilityId: 1000,
    configuredCapabilityIds: Object.freeze([27, 1000]),
    activeIdentityIds: Object.freeze([1000, 1000]),
    activePrimaryCapabilityIds: Object.freeze([1000, 1000]),
    activeCapabilityIds: Object.freeze([27, 1000]),
    ...overrides,
  });
}

test('native current-principal observation reports exact active numeric credentials', () => {
  const calls = [];
  const observed = observeCurrentPrincipalCapabilities({ platform: 'linux' }, {
    readRealIdentityId: () => { calls.push('real-id'); return 1000; },
    readEffectiveIdentityId: () => { calls.push('effective-id'); return 1000; },
    readRealPrimaryCapabilityId: () => { calls.push('real-primary'); return 1000; },
    readEffectivePrimaryCapabilityId: () => { calls.push('effective-primary'); return 1000; },
    readCapabilityIds: () => { calls.push('capabilities'); return [1000, 27]; },
  });
  assert.deepEqual(observed, {
    protocol: CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL,
    platform: 'linux',
    applicable: true,
    identityIds: [1000, 1000],
    primaryCapabilityIds: [1000, 1000],
    capabilityIds: [27, 1000],
  });
  assert.deepEqual(calls, ['real-id', 'effective-id', 'real-primary', 'effective-primary', 'capabilities']);
});

test('native observation is unattached off Linux and rejects malformed active evidence', () => {
  let invoked = false;
  const observed = observeCurrentPrincipalCapabilities({ platform: 'win32' }, {
    readCapabilityIds: () => { invoked = true; return [1]; },
  });
  assert.deepEqual(observed, { protocol: CURRENT_PRINCIPAL_CAPABILITIES_PROTOCOL, platform: 'win32', applicable: false });
  assert.equal(invoked, false);

  const ports = {
    readRealIdentityId: () => 1000,
    readEffectiveIdentityId: () => 1000,
    readRealPrimaryCapabilityId: () => 1000,
    readEffectivePrimaryCapabilityId: () => 1000,
    readCapabilityIds: () => [27],
  };
  assert.throws(() => observeCurrentPrincipalCapabilities({ platform: 'linux' }, ports), /observation failed/u);
  assert.throws(() => observeCurrentPrincipalCapabilities({ platform: 'linux' }, { ...ports, readCapabilityIds: () => [1000, 1000] }), /observation failed/u);
  assert.throws(() => observeCurrentPrincipalCapabilities({ platform: 'linux', path: '/tmp' }, ports), /unknown field/u);
});

test('pure separation policy accepts only one exact non-privileged separated principal', () => {
  assert.deepEqual(assessCapabilitySeparation({ principal: principal(), restrictedCapabilityIds: [980, 981] }), {
    protocol: CAPABILITY_SEPARATION_PROTOCOL,
    exact: true,
    separated: true,
    reason: null,
  });
  assert.equal(assessCapabilitySeparation({ principal: principal({ configuredCapabilityIds: [980, 1000] }), restrictedCapabilityIds: [980, 981] }).reason, 'configured-capability-present');
  assert.equal(assessCapabilitySeparation({ principal: principal({ activeCapabilityIds: [981, 1000] }), restrictedCapabilityIds: [980, 981] }).reason, 'active-capability-present');
  assert.equal(assessCapabilitySeparation({ principal: principal({ activeIdentityIds: [1000, 1001] }), restrictedCapabilityIds: [980] }).reason, 'identity-mismatch');
  assert.equal(assessCapabilitySeparation({ principal: principal({ identityId: 0, activeIdentityIds: [0, 0] }), restrictedCapabilityIds: [980] }).reason, 'principal-is-privileged');
  assert.throws(() => assessCapabilitySeparation({ principal: principal(), restrictedCapabilityIds: [980, 980] }), /duplicate/u);
  assert.throws(() => assessCapabilitySeparation({ principal: { ...principal(), route: 'foreign' }, restrictedCapabilityIds: [980] }), /unknown field/u);
});

test('Linux composition selects one neutral capability only after complete separation', async () => {
  const selected = fixture();
  const observed = await observeLinuxProviderAuthorityPreflight({ principal: 'alice', platform: 'linux' }, selected.ports);
  assert.deepEqual(observed, {
    protocol: LINUX_PROVIDER_AUTHORITY_PREFLIGHT_PROTOCOL,
    platform: 'linux',
    applicable: true,
    observable: true,
    exact: true,
    separation: 'verified',
    selectedCapability: { name: 'primary_control', id: 980 },
    capabilities: CAPABILITIES,
    reason: null,
  });
  assert.deepEqual(selected.calls.map(([name]) => name), ['route', 'records', 'current', 'assess']);
  assert.deepEqual(selected.calls[1][1], {
    accountNames: ['alice'],
    groupNames: ['primary_control', 'compat_control'],
    platform: 'linux',
  });
  assert.deepEqual(selected.calls[3][1].restrictedCapabilityIds, [980, 981]);
  assert.equal(JSON.stringify(observed).includes('/run/'), false);
});

test('configured-only and inherited-active-only authority each withhold selection', async () => {
  const configured = fixture({ identities: identities({ groupIds: [980, 1000] }) });
  const configuredResult = await observeLinuxProviderAuthorityPreflight({ principal: 'alice', platform: 'linux' }, configured.ports);
  assert.equal(configuredResult.exact, false);
  assert.equal(configuredResult.selectedCapability, null);
  assert.equal(configuredResult.reason, 'configured-capability-present');

  const active = fixture({ current: current({ capabilityIds: Object.freeze([981, 1000]) }) });
  const activeResult = await observeLinuxProviderAuthorityPreflight({ principal: 'alice', platform: 'linux' }, active.ports);
  assert.equal(activeResult.exact, false);
  assert.equal(activeResult.selectedCapability, null);
  assert.equal(activeResult.reason, 'active-capability-present');
});

test('identity mismatch and capability rebinding fail closed with bounded evidence', async () => {
  const mismatch = fixture({ current: current({ identityIds: Object.freeze([1000, 1001]) }) });
  const mismatchResult = await observeLinuxProviderAuthorityPreflight({ principal: 'alice', platform: 'linux' }, mismatch.ports);
  assert.equal(mismatchResult.reason, 'identity-mismatch');

  const rebound = fixture({ identities: identities({ groupOverrides: new Map([['compat_control', 982]]) }) });
  const reboundResult = await observeLinuxProviderAuthorityPreflight({ principal: 'alice', platform: 'linux' }, rebound.ports);
  assert.equal(reboundResult.reason, 'identity-evidence-invalid');
  assert.equal(reboundResult.selectedCapability, null);
});

test('widened or unbounded child evidence is replaced with a bounded failure', async () => {
  const widenedCurrent = fixture({ current: Object.freeze({ ...current(), path: '/sensitive/current' }) });
  const currentResult = await observeLinuxProviderAuthorityPreflight({ principal: 'alice', platform: 'linux' }, widenedCurrent.ports);
  assert.equal(currentResult.reason, 'current-observation-unavailable');
  assert.equal(JSON.stringify(currentResult).includes('/sensitive/'), false);

  const selected = fixture();
  const policyResult = await observeLinuxProviderAuthorityPreflight({ principal: 'alice', platform: 'linux' }, {
    ...selected.ports,
    assess: () => Object.freeze({
      protocol: CAPABILITY_SEPARATION_PROTOCOL,
      exact: false,
      separated: false,
      reason: '/sensitive/policy',
    }),
  });
  assert.equal(policyResult.reason, 'separation-evidence-invalid');
  assert.equal(JSON.stringify(policyResult).includes('/sensitive/'), false);
});

test('non-group-only topology stops before principal observation', async () => {
  const selected = fixture({ topology: topology({ exact: true, classification: 'policy-backed', selectedCapability: null, capabilities: Object.freeze([]) }) });
  const observed = await observeLinuxProviderAuthorityPreflight({ principal: 'alice', platform: 'linux' }, selected.ports);
  assert.equal(observed.reason, 'topology-not-group-only');
  assert.deepEqual(selected.calls.map(([name]) => name), ['route']);
});

test('non-Linux and widened composition contracts invoke no local authority', async () => {
  let invoked = false;
  const ports = { inspectRoute: async () => { invoked = true; return null; } };
  const observed = await observeLinuxProviderAuthorityPreflight({ platform: 'win32' }, ports);
  assert.equal(observed.applicable, false);
  assert.equal(invoked, false);
  await assert.rejects(() => observeLinuxProviderAuthorityPreflight({ principal: 'alice', platform: 'linux', executable: '/bin/id' }, ports), /unknown field/u);
  assert.equal(invoked, false);
});

test('children are isolated and the composition root exposes no mutation or concrete topology', async () => {
  const childFiles = ['../src/setup/current-principal-capabilities.js', '../src/setup/capability-separation.js'];
  for (const relative of childFiles) {
    const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    for (const forbidden of ['./linux-', './capability-', 'libvirt', 'qemu', 'systemctl', 'getent', 'lifecycle', 'repository', 'useradd', 'usermod', 'groupadd', 'sudo', 'pkexec']) {
      assert.equal(source.includes(forbidden), false, `${relative} gained foreign context through ${forbidden}`);
    }
  }
  const parent = await readFile(fileURLToPath(new URL('../src/setup/linux-provider-authority-preflight.js', import.meta.url)), 'utf8');
  for (const forbidden of ['/run/', '/etc/', 'virtqemud', 'libvirtd', 'virtproxyd', 'virsh', 'systemctl', 'useradd', 'usermod', 'groupadd', 'sudo', 'pkexec']) {
    assert.equal(parent.includes(forbidden), false, `composition root gained concrete or mutation authority through ${forbidden}`);
  }
});
