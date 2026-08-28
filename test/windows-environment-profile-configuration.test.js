import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsEnvironmentProfileConfiguration } from '../src/setup/windows-environment-profile-configuration.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  EnvironmentProfileConfigurationRegistry,
} from '../src/runtime/environment-profile-configuration.js';
import {
  ENVIRONMENT_DECLARATION_PROTOCOL,
  EnvironmentDeclarationRegistry,
  environmentDeclarationDigest,
} from '../src/runtime/environment-declaration.js';
import { createEnvironmentProfileConfigurationStateStore } from '../src/state/environment-profile-configuration-state-store.js';

function declaration() {
  return {
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: 'profile-a',
    schemaGeneration: 'schema-v1',
    guest: { family: 'guest', generation: 'guest-v1' },
    image: { identity: 'image-a', generation: 'image-v1' },
    resources: { memoryBytes: 2_147_483_648, processorCount: 2 },
    boot: { requirement: 'efi-v1' },
    network: { requirement: 'egress-v1' },
    bootstrap: { generation: 'bootstrap-v1', requirements: ['compiler-c'] },
    enrollment: { requirement: 'trust-v1' },
    workspaces: [],
    protectedStateClasses: [],
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

function clearConflict() {
  return {
    async inspect() { return { protocol: 'devbridge/setup-resource-conflict-v1', state: 'clear', subject: null, reason: null }; },
    async retire() { throw new Error('clear setup conflict must not retire'); },
  };
}

test('Windows setup reconciles accepted configuration only inside exact protected authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-configuration-'));
  try {
    const accepted = new EnvironmentProfileConfigurationRegistry({
      port: createEnvironmentProfileConfigurationStateStore(path.join(root, 'environment-profile-configuration', 'state.json')),
      now: () => '2026-08-28T12:00:00.000Z',
    });
    await accepted.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations: [declaration()] });
    const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort(), now: () => '2026-08-28T12:01:00.000Z' });
    let adoptions = 0;
    let storage = false;
    let networking = false;
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32', invoke: async () => {} }, {
      adoptImages: async () => { adoptions += 1; return { ready: true }; },
      foundationFactory: async () => ({
        async inspect() {
          return {
            identity: 'foundation-a',
            capabilities: {
              management: { ready: true },
              storage: { ready: storage },
              networking: { ready: networking },
            },
          };
        },
        async ensureStorage() { storage = true; return { ready: true }; },
        async ensureNetwork() { networking = true; return { ready: true }; },
        async listImages() { return [{ identity: 'image-a', profile: 'profile-a', generation: 'image-v1', retiredAt: null }]; },
        async verifyImage(identity) { return { identity, usable: true, verified: true }; },
      }),
      lifecycleFactory: () => ({ declarations }),
      activityFactory: () => ({
        async inspect() {
          return { ready: storage && networking, identity: 'foundation-a', reason: storage && networking ? null : 'unavailable' };
        },
      }),
      conflictFactory: clearConflict,
    });
    assert.equal((await configuration.inspect({ client: { list: async () => [] } })).ready, false);
    const plan = {
      protocol: 'devbridge/windows-lifecycle-authority-plan-v1',
      stateDirectory: path.win32.resolve(root),
      authorityDirectory: path.join(root, 'protected'),
    };
    const first = await configuration.reconcile({ plan });
    const record = (await declarations.list())[0];
    assert.equal(first.ready, true);
    assert.equal(first.changed, true);
    assert.equal(adoptions, 1);
    assert.equal(storage, true);
    assert.equal(networking, true);
    const status = [{ profile: record.declaration.profile, declarationRevision: record.revision, declarationDigest: environmentDeclarationDigest(record.declaration) }];
    assert.equal((await configuration.inspect({ client: { list: async () => status } })).ready, true);
    assert.equal((await configuration.reconcile({ plan })).changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary inspection requires protected resource readiness as well as exact declarations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-resources-'));
  try {
    const accepted = new EnvironmentProfileConfigurationRegistry({
      port: createEnvironmentProfileConfigurationStateStore(path.join(root, 'environment-profile-configuration', 'state.json')),
    });
    const record = (await accepted.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations: [declaration()] })).record;
    const status = [{
      profile: 'profile-a',
      declarationRevision: 1,
      declarationDigest: environmentDeclarationDigest(record.configuration.declarations[0]),
    }];
    let networking = false;
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' }, {
      activityFactory: () => ({
        async inspect() {
          return { ready: networking, identity: 'foundation-a', reason: networking ? null : 'unavailable' };
        },
      }),
    });
    assert.equal((await configuration.inspect({ client: { list: async () => status } })).ready, false);
    networking = true;
    assert.equal((await configuration.inspect({ client: { list: async () => status } })).ready, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected reconciliation does not publish declarations when resource authority is unavailable or changes identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-resource-boundary-'));
  try {
    const accepted = new EnvironmentProfileConfigurationRegistry({
      port: createEnvironmentProfileConfigurationStateStore(path.join(root, 'environment-profile-configuration', 'state.json')),
    });
    await accepted.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations: [declaration()] });
    const plan = {
      protocol: 'devbridge/windows-lifecycle-authority-plan-v1',
      stateDirectory: path.win32.resolve(root),
      authorityDirectory: path.join(root, 'protected'),
    };
    const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort() });
    let storageCalls = 0;
    let networkCalls = 0;
    const unavailable = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' }, {
      adoptImages: async () => ({ ready: true }),
      foundationFactory: async () => ({
        async inspect() {
          return {
            identity: 'foundation-a',
            capabilities: {
              management: { ready: false },
              storage: { ready: false },
              networking: { ready: false },
            },
          };
        },
        async ensureStorage() { storageCalls += 1; return { ready: true }; },
        async ensureNetwork() { networkCalls += 1; return { ready: true }; },
      }),
      lifecycleFactory: () => ({ declarations }),
    });
    await assert.rejects(unavailable.reconcile({ plan }), /management is unavailable/u);
    assert.equal(storageCalls, 0);
    assert.equal(networkCalls, 0);
    assert.deepEqual(await declarations.list(), []);

    let inspections = 0;
    const changedIdentity = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' }, {
      adoptImages: async () => ({ ready: true }),
      foundationFactory: async () => ({
        async inspect() {
          inspections += 1;
          return {
            identity: inspections === 1 ? 'foundation-a' : 'foundation-b',
            capabilities: {
              management: { ready: true },
              storage: { ready: inspections > 1 },
              networking: { ready: inspections > 1 },
            },
          };
        },
        async ensureStorage() { return { ready: true }; },
        async ensureNetwork() { return { ready: true }; },
      }),
      lifecycleFactory: () => ({ declarations }),
      conflictFactory: clearConflict,
    });
    await assert.rejects(changedIdentity.reconcile({ plan }), /did not verify after reconciliation/u);
    assert.deepEqual(await declarations.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('privileged configuration intake rejects ordinary filesystem indirection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-input-'));
  try {
    const directory = path.join(root, 'environment-profile-configuration');
    await mkdir(directory);
    const target = path.join(root, 'outside.json');
    const file = path.join(directory, 'state.json');
    await writeFile(target, '{}\n');
    try { await symlink(target, file, 'file'); }
    catch (error) {
      if (error?.code === 'EPERM') { t.skip('symbolic link creation is unavailable on this Windows host'); return; }
      throw error;
    }
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' });
    await assert.rejects(configuration.inspect({ client: { list: async () => [] } }), /bounded real file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('privileged configuration intake rejects an unbounded ordinary state file before parsing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-size-'));
  try {
    const directory = path.join(root, 'environment-profile-configuration');
    await mkdir(directory);
    await writeFile(path.join(directory, 'state.json'), 'x'.repeat(3 * 1024 * 1024));
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' });
    await assert.rejects(configuration.inspect({ client: { list: async () => [] } }), /bounded real file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected reconciliation rejects an incomplete authority plan as data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-plan-'));
  try {
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' });
    await assert.rejects(
      configuration.reconcile({ plan: { protocol: 'devbridge/windows-lifecycle-authority-plan-v1', authorityDirectory: path.join(root, 'protected') } }),
      /authority plan is invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected configuration retires only an exact accepted conflict before owned network reconciliation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-conflict-'));
  try {
    const accepted = new EnvironmentProfileConfigurationRegistry({
      port: createEnvironmentProfileConfigurationStateStore(path.join(root, 'environment-profile-configuration', 'state.json')),
    });
    await accepted.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations: [declaration()] });
    const subject = 'c'.repeat(64);
    const calls = [];
    const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort() });
    let storage = false;
    let networking = false;
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' }, {
      adoptImages: async () => ({ ready: true }),
      foundationFactory: async () => ({
        async inspect() {
          return {
            identity: 'd'.repeat(32),
            capabilities: {
              management: { ready: true },
              storage: { ready: storage },
              networking: { ready: networking },
            },
          };
        },
        async ensureStorage() { calls.push('storage'); storage = true; return { ready: true }; },
        async ensureNetwork() { calls.push('network'); networking = true; return { ready: true }; },
        async listImages() { return [{ identity: 'image-a', profile: 'profile-a', generation: 'image-v1', retiredAt: null }]; },
        async verifyImage(identity) { return { identity, usable: true, verified: true }; },
      }),
      lifecycleFactory: () => ({ declarations }),
      conflictFactory: () => ({
        async inspect() {
          calls.push('conflict-inspect');
          return { protocol: 'devbridge/setup-resource-conflict-v1', state: 'approval-required', subject, reason: 'approval required' };
        },
        async retire(consent) {
          calls.push('conflict-retire');
          assert.equal(consent.subject, subject);
          return { protocol: 'devbridge/setup-resource-conflict-retirement-v1', ready: true, changed: true, reason: null };
        },
      }),
      consentStoreFactory: () => ({ async load() { return { protocol: 'devbridge/setup-resource-conflict-consent-v1', subject }; } }),
    });
    const result = await configuration.reconcile({
      plan: {
        protocol: 'devbridge/windows-lifecycle-authority-plan-v1',
        stateDirectory: path.win32.resolve(root),
        authorityDirectory: path.join(root, 'protected'),
      },
    });
    assert.equal(result.ready, true);
    assert.equal(result.changed, true);
    assert.deepEqual(calls.slice(0, 4), ['conflict-inspect', 'conflict-retire', 'storage', 'network']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
