import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentEffectChannel } from '../src/runtime/persistent-environments/effect-channel.js';

const SOURCE = 'img-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const IDENTITY = `env-${'1'.repeat(32)}`;

function sourceValue() {
  return { identity: SOURCE, profile: 'profile-a', revision: 'revision-a', digest: 'a'.repeat(64), handle: { opaque: true } };
}

function observation(overrides = {}) {
  return {
    identity: IDENTITY,
    exists: true,
    owned: true,
    compatible: true,
    state: 'stopped',
    reason: null,
    storage: { identity: 'storage-a', sourceIdentity: SOURCE, allocatedBytes: 4096 },
    ...overrides,
  };
}

test('nested effect channel translates only the neutral source and observation contracts', async () => {
  let provisioned;
  const actions = {
    async inspect() { return { identity: '1'.repeat(32) }; },
    async observe() { return observation(); },
    async provision(value) { provisioned = value; return observation(); },
    async start() { return observation({ state: 'running' }); },
    async stop() { return observation(); },
    async drop() { return { identity: IDENTITY, removed: true, absent: false }; },
  };
  const channel = new EnvironmentEffectChannel({ source: { async resolve() { return sourceValue(); } }, actions });
  assert.equal(await channel.binding(), '1'.repeat(32));
  const resolved = await channel.resolve({ subject: 'opaque', profile: 'profile-a', sourceIdentity: SOURCE, settings: {} });
  assert.deepEqual(channel.record(resolved), { identity: SOURCE, profile: 'profile-a', revision: 'revision-a', digest: 'a'.repeat(64) });
  const observed = await channel.provision({ identity: IDENTITY, source: resolved, settings: { processorCount: 2 } });
  channel.requireSource(observed, SOURCE);
  assert.deepEqual(provisioned.source, { identity: SOURCE, revision: 'revision-a', digest: 'a'.repeat(64), handle: { opaque: true } });
  assert.equal('profile' in provisioned.source, false);
  assert.equal(observed.storageState, 'present');
});

test('nested effect channel rejects substituted identities, foreign fields, and changed lineage', async () => {
  const base = {
    async inspect() { return { identity: '1'.repeat(32) }; },
    async provision() { return observation(); },
    async observe() { return observation({ identity: `env-${'2'.repeat(32)}` }); },
    async start() { return observation(); },
    async stop() { return observation(); },
    async drop() { return { identity: IDENTITY, removed: true }; },
  };
  const channel = new EnvironmentEffectChannel({ source: { async resolve() { return { ...sourceValue(), repository: 'foreign' }; } }, actions: base });
  await assert.rejects(() => channel.resolve({ subject: 'opaque', profile: 'profile-a', sourceIdentity: SOURCE, settings: {} }), /repository is not allowed/u);
  await assert.rejects(() => channel.observe(IDENTITY), /observation identity changed/u);
  assert.throws(() => channel.requireSource(observation({ storage: { identity: 'storage-a', sourceIdentity: 'other', allocatedBytes: 1 } }), SOURCE), /writable lineage does not match/u);
});
