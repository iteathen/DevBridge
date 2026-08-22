import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVIRONMENT_DECLARATION_PROTOCOL, logicalEnvironmentIdentity } from '../src/runtime/environment-declaration.js';
import { diagnoseEnvironment } from '../src/runtime/environment-diagnosis.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../src/runtime/environment-observation.js';

function declaration() {
  const value = {
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: 'linux-development', schemaGeneration: 'profile-v1',
    guest: { family: 'ubuntu', generation: '24.04.4' },
    image: { identity: 'image-ubuntu-v1', generation: 'ubuntu-v1' },
    resources: { memoryBytes: 4294967296, processorCount: 4 },
    boot: { requirement: 'efi-v1' }, network: { requirement: 'managed-egress-v1' },
    bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
    enrollment: { requirement: 'unique-guest-trust-v1' }, workspaces: [], protectedStateClasses: [],
  };
  return { identity: logicalEnvironmentIdentity(value.profile), revision: 1, declaration: value };
}
function observation(record, overrides = {}) {
  return {
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
    environmentIdentity: record.identity, declarationRevision: record.revision,
    implementationGeneration: 'implementation-generation-1', materialization: 'present', systemStorage: 'present',
    attachment: 'ready', enrollment: 'ready', bootstrap: 'ready', guest: 'healthy', transition: 'clear', ...overrides,
  };
}

test('missing system storage is typed rebuild and never repair', () => {
  const record = declaration();
  const result = diagnoseEnvironment({ declaration: record, observation: observation(record, { systemStorage: 'absent' }) });
  assert.equal(result.state, 'degraded');
  assert.equal(result.cause, 'system-storage-missing');
  assert.equal(result.repairableInPlace, false);
  assert.equal(result.supportedNextAction, 'rebuild');
  assert.deepEqual(result.impact.unavailable, ['guest-mutable-state']);
  assert.deepEqual(result.impact.reseedable, ['workspace-source']);
});

test('invalid lineage is distinct from missing storage and remains rebuild-only', () => {
  const record = declaration();
  const result = diagnoseEnvironment({ declaration: record, observation: observation(record, { systemStorage: 'invalid', attachment: 'invalid' }) });
  assert.equal(result.cause, 'system-storage-invalid');
  assert.equal(result.supportedNextAction, 'rebuild');
  assert.equal(result.repairableInPlace, false);
});

test('safe in-place degradation classes route to repair', () => {
  const record = declaration();
  const cases = [
    [observation(record, { attachment: 'invalid' }), {}, 'attachment-invalid'],
    [observation(record, { enrollment: 'missing' }), {}, 'enrollment-missing'],
    [observation(record, { enrollment: 'stale' }), {}, 'enrollment-stale'],
    [observation(record, { bootstrap: 'degraded' }), {}, 'bootstrap-degraded'],
    [observation(record), { network: 'degraded' }, 'network-degraded'],
    [observation(record, { guest: 'degraded' }), { workspaces: 'degraded' }, 'workspace-degraded'],
    [observation(record, { transition: 'incomplete' }), {}, 'transition-incomplete'],
  ];
  for (const [observed, extra, cause] of cases) {
    const result = diagnoseEnvironment({ declaration: record, observation: observed, ...extra });
    assert.equal(result.cause, cause);
    assert.equal(result.repairableInPlace, true);
    assert.equal(result.supportedNextAction, 'repair');
  }
});

test('provider, resource, and ownership blockers fail closed', () => {
  const record = declaration();
  const provider = diagnoseEnvironment({ declaration: record, observation: observation(record, { materialization: 'unavailable', implementationGeneration: null, systemStorage: 'unknown', attachment: 'unknown', enrollment: 'unknown', bootstrap: 'unknown', guest: 'unknown' }) });
  assert.equal(provider.cause, 'provider-unavailable');
  assert.equal(provider.supportedNextAction, 'provider-action-required');

  const resource = diagnoseEnvironment({ declaration: record, observation: observation(record), resources: 'blocked' });
  assert.equal(resource.cause, 'resource-admission-failed');
  assert.equal(resource.supportedNextAction, 'provider-action-required');

  const foreign = diagnoseEnvironment({ declaration: record, observation: observation(record), ownership: 'foreign' });
  assert.equal(foreign.cause, 'foreign-provider-collision');
  assert.equal(foreign.supportedNextAction, 'manual-review');
});

test('missing materialization is not stretched into an unsafe in-place repair', () => {
  const record = declaration();
  const result = diagnoseEnvironment({ declaration: record, observation: observation(record, { materialization: 'missing', systemStorage: 'present', attachment: 'unknown', enrollment: 'unknown', bootstrap: 'unknown', guest: 'unknown' }) });
  assert.equal(result.cause, 'materialization-missing');
  assert.equal(result.repairableInPlace, false);
  assert.equal(result.supportedNextAction, 'recreate');
});

test('stopped, paused, or saved exact materialization routes to start rather than repair', () => {
  const record = declaration();
  for (const execution of ['stopped', 'paused', 'saved']) {
    const result = diagnoseEnvironment({ declaration: record, observation: observation(record), execution });
    assert.equal(result.cause, 'materialization-not-running');
    assert.equal(result.supportedNextAction, 'start');
    assert.equal(result.repairableInPlace, false);
  }
});

test('stale observations and competing lifecycle transitions cannot authorize repair', () => {
  const record = declaration();
  const stale = diagnoseEnvironment({ declaration: record, observation: observation(record, { declarationRevision: 2 }) });
  assert.equal(stale.cause, 'observation-stale');
  assert.equal(stale.supportedNextAction, 'manual-review');
  const active = diagnoseEnvironment({ declaration: record, observation: observation(record), activeTransition: 'other' });
  assert.equal(active.cause, 'lifecycle-transition-incomplete');
  assert.equal(active.repairableInPlace, false);
});
