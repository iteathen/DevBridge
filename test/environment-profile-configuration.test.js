import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  EnvironmentProfileConfigurationRegistry,
  environmentProfileConfigurationDigest,
  inspectEnvironmentProfileConfiguration,
  reconcileEnvironmentProfileConfiguration,
} from '../src/runtime/environment-profile-configuration.js';
import {
  ENVIRONMENT_DECLARATION_PROTOCOL,
  EnvironmentDeclarationRegistry,
  environmentDeclarationDigest,
} from '../src/runtime/environment-declaration.js';

function declaration(profile = 'profile-a', image = 'image-a') {
  return {
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile,
    schemaGeneration: 'schema-v1',
    guest: { family: 'guest', generation: 'guest-v1' },
    image: { identity: image, generation: 'image-v1' },
    resources: { memoryBytes: 2_147_483_648, processorCount: 2 },
    boot: { requirement: 'efi-v1' },
    network: { requirement: 'egress-v1' },
    bootstrap: { generation: 'bootstrap-v1', requirements: ['compiler-c'] },
    enrollment: { requirement: 'trust-v1' },
    workspaces: [{ identity: 'workspace-a', authority: '42' }],
    protectedStateClasses: [],
  };
}

function singletonPort() {
  let value = null;
  return {
    async load() { return structuredClone(value); },
    async save(next) { value = structuredClone(next); },
  };
}

function keyedPort() {
  const values = new Map();
  return {
    async load(key) { return structuredClone(values.get(key) ?? null); },
    async save(key, value) { values.set(key, structuredClone(value)); },
    async scan() { return [...values.values()].map((entry) => structuredClone(entry)); },
  };
}

async function configuration(...declarations) {
  const registry = new EnvironmentProfileConfigurationRegistry({ port: singletonPort(), now: () => '2026-08-28T12:00:00.000Z' });
  return (await registry.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations })).record;
}

function imageAuthority(...declarations) {
  const entries = declarations.map((entry) => ({
    identity: entry.image.identity,
    profile: entry.profile,
    generation: entry.image.generation,
    retiredAt: null,
  }));
  return {
    async list() { return structuredClone(entries); },
    async verify(identity) { return { identity, usable: true, verified: true }; },
  };
}

test('accepted profile configuration is canonical, revisioned, and idempotent', async () => {
  const registry = new EnvironmentProfileConfigurationRegistry({ port: singletonPort(), now: () => '2026-08-28T12:00:00.000Z' });
  const first = await registry.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations: [declaration('profile-b', 'image-b'), declaration()] });
  const second = await registry.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations: [declaration(), declaration('profile-b', 'image-b')] });
  assert.equal(first.changed, true);
  assert.equal(first.record.revision, 1);
  assert.equal(second.changed, false);
  assert.equal(second.record.digest, environmentProfileConfigurationDigest(second.record.configuration));
  assert.deepEqual(second.record.configuration.declarations.map((entry) => entry.profile), ['profile-a', 'profile-b']);
});

test('protected reconciliation verifies every image before CAS registration and then becomes a no-op', async () => {
  const desired = declaration();
  const record = await configuration(desired);
  const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort(), now: () => '2026-08-28T12:01:00.000Z' });
  const first = await reconcileEnvironmentProfileConfiguration(record, { declarations, images: imageAuthority(desired) });
  const second = await reconcileEnvironmentProfileConfiguration(record, { declarations, images: imageAuthority(desired) });
  assert.equal(first.ready, true);
  assert.equal(first.changed, true);
  assert.equal(first.declarations[0].revision, 1);
  assert.equal(first.declarations[0].digest, environmentDeclarationDigest(desired));
  assert.equal(second.changed, false);
});

test('protected reconciliation fails before mutation for image mismatch or an unaccepted declaration', async () => {
  const desired = declaration();
  const record = await configuration(desired);
  const empty = new EnvironmentDeclarationRegistry({ port: keyedPort() });
  await assert.rejects(
    reconcileEnvironmentProfileConfiguration(record, { declarations: empty, images: imageAuthority(declaration('profile-a', 'other-image')) }),
    /unavailable or ambiguous/u,
  );
  assert.equal((await empty.list()).length, 0);

  const occupied = new EnvironmentDeclarationRegistry({ port: keyedPort() });
  await occupied.register(declaration('profile-extra', 'image-extra'));
  await assert.rejects(
    reconcileEnvironmentProfileConfiguration(record, { declarations: occupied, images: imageAuthority(desired) }),
    /outside accepted configuration/u,
  );
  assert.equal((await occupied.list()).length, 1);
});

test('ordinary inspection requires the exact accepted declaration digest and no extra profile', async () => {
  const desired = declaration();
  const record = await configuration(desired);
  const exact = [{ profile: desired.profile, declarationRevision: 1, declarationDigest: environmentDeclarationDigest(desired) }];
  assert.equal(inspectEnvironmentProfileConfiguration(record, exact).ready, true);
  assert.equal(inspectEnvironmentProfileConfiguration(record, []).ready, false);
  assert.equal(inspectEnvironmentProfileConfiguration(record, [{ ...exact[0], declarationDigest: '0'.repeat(64) }]).ready, false);
});
