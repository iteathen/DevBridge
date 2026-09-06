import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COMPUTE_CAPABILITY_PROTOCOL,
  COMPUTE_CAPABILITY_STATUS,
  COMPUTE_REQUIREMENT_PROTOCOL,
  COMPUTE_TOPOLOGY,
  matchComputeCapability,
  normalizeComputeCapability,
  normalizeComputeRequirement,
} from '../src/runtime/compute-capabilities.js';

function requirement(overrides = {}) {
  return {
    protocol: COMPUTE_REQUIREMENT_PROTOCOL,
    api: 'cuda',
    features: ['kernel-launch', 'memory-transfer', 'synchronize'],
    evidence: ['functional', 'hardware-backed'],
    topology: COMPUTE_TOPOLOGY.HOST_RETAINED,
    ...overrides,
  };
}

function capability(overrides = {}) {
  return {
    protocol: COMPUTE_CAPABILITY_PROTOCOL,
    subject: 'accelerator-capability-01',
    generation: 'capability-generation-01',
    profile: 'linux+cuda',
    environment: {
      identity: 'environment-01',
      generation: 'environment-generation-01',
    },
    api: 'cuda',
    features: ['kernel-launch', 'memory-transfer', 'synchronize'],
    evidence: ['functional', 'hardware-backed'],
    topology: COMPUTE_TOPOLOGY.HOST_RETAINED,
    status: COMPUTE_CAPABILITY_STATUS.QUALIFIED,
    qualification: {
      identity: 'qualification-01',
      generation: 'qualification-generation-01',
    },
    blocker: null,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    profile: 'linux+cuda',
    environment: {
      identity: 'environment-01',
      generation: 'environment-generation-01',
    },
    ...overrides,
  };
}

test('compute requirement normalizes bounded neutral semantics', () => {
  const normalized = normalizeComputeRequirement(requirement({
    features: ['synchronize', 'kernel-launch', 'memory-transfer'],
    evidence: ['hardware-backed', 'functional'],
  }));
  assert.deepEqual(normalized.features, ['kernel-launch', 'memory-transfer', 'synchronize']);
  assert.deepEqual(normalized.evidence, ['functional', 'hardware-backed']);
  assert.equal(normalized.topology, COMPUTE_TOPOLOGY.HOST_RETAINED);
  assert.equal(Object.isFrozen(normalized), true);
});

test('qualified capability requires exact qualification evidence', () => {
  assert.throws(
    () => normalizeComputeCapability(capability({ qualification: null })),
    /requires exact qualification evidence/,
  );
});

test('unknown and unsupported capabilities require a blocker, carry no qualification, and never match', () => {
  for (const status of [COMPUTE_CAPABILITY_STATUS.UNKNOWN, COMPUTE_CAPABILITY_STATUS.UNSUPPORTED]) {
    const observed = capability({ status, qualification: null, blocker: 'backend-unavailable' });
    const result = matchComputeCapability(requirement(), observed, context());
    assert.equal(result.matched, false);
    assert.equal(result.code, 'COMPUTE_REQUIREMENT_UNSATISFIED');
    assert.deepEqual(result.mismatches, ['capability-not-qualified']);
  }
  assert.throws(
    () => normalizeComputeCapability(capability({ status: COMPUTE_CAPABILITY_STATUS.UNKNOWN, qualification: null, blocker: null })),
    /requires an exact blocker/,
  );
  assert.throws(
    () => normalizeComputeCapability(capability({ status: COMPUTE_CAPABILITY_STATUS.UNKNOWN, blocker: 'backend-unavailable' })),
    /cannot carry qualification evidence/,
  );
});

test('matching requires exact profile and environment generations', () => {
  const exact = matchComputeCapability(requirement(), capability(), context());
  assert.equal(exact.matched, true);
  assert.equal(exact.code, 'COMPUTE_REQUIREMENT_SATISFIED');

  const stale = matchComputeCapability(requirement(), capability(), context({
    environment: { identity: 'environment-01', generation: 'environment-generation-02' },
  }));
  assert.equal(stale.matched, false);
  assert.deepEqual(stale.mismatches, ['environment-generation']);

  const wrongProfile = matchComputeCapability(requirement(), capability(), context({ profile: 'windows+cuda' }));
  assert.equal(wrongProfile.matched, false);
  assert.deepEqual(wrongProfile.mismatches, ['profile']);
});

test('matching reports missing semantic features and evidence without fallback inference', () => {
  const result = matchComputeCapability(
    requirement({
      features: ['kernel-launch', 'memory-transfer', 'synchronize', 'device-graphs'],
      evidence: ['functional', 'hardware-backed', 'performance-qualified'],
    }),
    capability({
      features: ['kernel-launch', 'memory-transfer', 'synchronize'],
      evidence: ['functional', 'performance-qualified'],
    }),
    context(),
  );
  assert.equal(result.matched, false);
  assert.deepEqual(result.missing.features, ['device-graphs']);
  assert.deepEqual(result.missing.evidence, ['hardware-backed']);
  assert.deepEqual(result.mismatches, []);
});

test('evidence is independent rather than an ordered quality score', () => {
  const result = matchComputeCapability(
    requirement({ evidence: ['hardware-backed'] }),
    capability({ evidence: ['performance-qualified'] }),
    context(),
  );
  assert.equal(result.matched, false);
  assert.deepEqual(result.missing.evidence, ['hardware-backed']);
});

test('host-retained requirement cannot be satisfied by a different neutral topology', () => {
  const result = matchComputeCapability(
    requirement(),
    capability({ topology: COMPUTE_TOPOLOGY.EXCLUSIVE }),
    context(),
  );
  assert.equal(result.matched, false);
  assert.deepEqual(result.mismatches, ['topology']);
});

test('protocol v1 represents other neutral topology classes without provider identity', () => {
  assert.equal(normalizeComputeCapability(capability({ topology: COMPUTE_TOPOLOGY.EMULATED_LOCAL })).topology, 'emulated-local');
  assert.equal(normalizeComputeCapability(capability({ topology: COMPUTE_TOPOLOGY.REMOTE })).topology, 'remote');
});

test('provider-shaped or unknown topology names require an explicit protocol revision', () => {
  assert.throws(
    () => normalizeComputeCapability(capability({ topology: 'wsl' })),
    /topology is unsupported/,
  );
  assert.throws(
    () => normalizeComputeRequirement(requirement({ topology: 'vfio' })),
    /topology is unsupported/,
  );
});

test('generic requirement and capability reject provider-shaped extension fields', () => {
  assert.throws(
    () => normalizeComputeRequirement({ ...requirement(), deviceId: 'local-device' }),
    /deviceId is not allowed/,
  );
  assert.throws(
    () => normalizeComputeCapability({ ...capability(), backendCommand: 'provider-operation' }),
    /backendCommand is not allowed/,
  );
});

test('generic compute capability implementation contains no provider-native vocabulary', async () => {
  const source = await readFile(new URL('../src/runtime/compute-capabilities.js', import.meta.url), 'utf8');
  for (const forbidden of [
    'nvidia', 'wsl', 'gpu-p', 'vgpu', 'hyper-v', 'vpci', 'vfio', 'libvirt', 'powershell', 'pnp', 'pci bdf',
  ]) {
    assert.equal(source.toLowerCase().includes(forbidden), false, `generic contract leaked ${forbidden}`);
  }
});
