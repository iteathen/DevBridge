import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsProtectedEnvironmentConfiguration } from '../src/app/windows-environment-configuration-host.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  EnvironmentProfileConfigurationRegistry,
} from '../src/runtime/environment-profile-configuration.js';
import {
  ENVIRONMENT_DECLARATION_PROTOCOL,
  EnvironmentDeclarationRegistry,
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

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-protected-configuration-'));
  const accepted = new EnvironmentProfileConfigurationRegistry({
    port: createEnvironmentProfileConfigurationStateStore(path.join(root, 'environment-profile-configuration', 'state.json')),
  });
  const record = (await accepted.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations: [declaration()] })).record;
  return { root, record };
}

function foundationState() {
  let storage = false;
  let networking = false;
  return {
    factory: async () => ({
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
  };
}

test('protected configuration reconciles only the exact accepted record subject', async () => {
  const { root, record } = await fixture();
  try {
    const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort() });
    const foundation = foundationState();
    let adoptions = 0;
    const configuration = createWindowsProtectedEnvironmentConfiguration({
      stateDirectory: root,
      authorityDirectory: path.join(root, 'protected'),
      platform: 'win32',
    }, {
      adoptImages: async () => { adoptions += 1; return { ready: true }; },
      foundationFactory: foundation.factory,
      lifecycleFactory: () => ({ declarations }),
      conflictFactory: clearConflict,
    });
    const first = await configuration.reconcile({ revision: record.revision, subject: record.digest });
    assert.deepEqual(first, { ready: true, changed: true, revision: record.revision, subject: record.digest });
    assert.equal(adoptions, 1);
    assert.equal((await declarations.list()).length, 1);
    assert.equal((await configuration.reconcile({ revision: record.revision, subject: record.digest })).changed, false);
    await assert.rejects(configuration.reconcile({ revision: record.revision, subject: 'f'.repeat(64) }), /subject changed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected configuration detects accepted-record drift before returning success', async () => {
  const { root, record } = await fixture();
  try {
    const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort() });
    const foundation = foundationState();
    let reads = 0;
    const configuration = createWindowsProtectedEnvironmentConfiguration({
      stateDirectory: root,
      authorityDirectory: path.join(root, 'protected'),
      platform: 'win32',
    }, {
      recordReader: async () => {
        reads += 1;
        return reads === 1 ? record : { ...record, revision: record.revision + 1 };
      },
      adoptImages: async () => ({ ready: true }),
      foundationFactory: foundation.factory,
      lifecycleFactory: () => ({ declarations }),
      conflictFactory: clearConflict,
    });
    await assert.rejects(
      configuration.reconcile({ revision: record.revision, subject: record.digest }),
      /subject changed/u,
    );
    assert.equal(reads, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected configuration stops before declarations when management is unavailable or changes identity', async () => {
  const { root, record } = await fixture();
  try {
    const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort() });
    const unavailable = createWindowsProtectedEnvironmentConfiguration({
      stateDirectory: root,
      authorityDirectory: path.join(root, 'protected'),
      platform: 'win32',
    }, {
      adoptImages: async () => ({ ready: true }),
      foundationFactory: async () => ({
        async inspect() { return { identity: 'a', capabilities: { management: { ready: false }, storage: { ready: false }, networking: { ready: false } } }; },
      }),
      lifecycleFactory: () => ({ declarations }),
    });
    await assert.rejects(unavailable.reconcile({ revision: record.revision, subject: record.digest }), /management is unavailable/u);
    assert.deepEqual(await declarations.list(), []);

    let inspections = 0;
    const changedIdentity = createWindowsProtectedEnvironmentConfiguration({
      stateDirectory: root,
      authorityDirectory: path.join(root, 'protected'),
      platform: 'win32',
    }, {
      adoptImages: async () => ({ ready: true }),
      foundationFactory: async () => ({
        async inspect() {
          inspections += 1;
          return { identity: inspections === 1 ? 'a' : 'b', capabilities: { management: { ready: true }, storage: { ready: inspections > 1 }, networking: { ready: inspections > 1 } } };
        },
        async ensureStorage() { return { ready: true }; },
        async ensureNetwork() { return { ready: true }; },
      }),
      lifecycleFactory: () => ({ declarations }),
      conflictFactory: clearConflict,
    });
    await assert.rejects(changedIdentity.reconcile({ revision: record.revision, subject: record.digest }), /did not verify/u);
    assert.deepEqual(await declarations.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected configuration retires only exact accepted conflict before resource reconciliation', async () => {
  const { root, record } = await fixture();
  try {
    const calls = [];
    const conflictSubject = 'c'.repeat(64);
    const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort() });
    const foundation = foundationState();
    const configuration = createWindowsProtectedEnvironmentConfiguration({
      stateDirectory: root,
      authorityDirectory: path.join(root, 'protected'),
      platform: 'win32',
    }, {
      adoptImages: async () => ({ ready: true }),
      foundationFactory: async (...args) => {
        const selected = await foundation.factory(...args);
        return {
          ...selected,
          async ensureStorage() { calls.push('storage'); return selected.ensureStorage(); },
          async ensureNetwork() { calls.push('network'); return selected.ensureNetwork(); },
        };
      },
      lifecycleFactory: () => ({ declarations }),
      conflictFactory: () => ({
        async inspect() { calls.push('conflict-inspect'); return { protocol: 'devbridge/setup-resource-conflict-v1', state: 'approval-required', subject: conflictSubject, reason: 'approval required' }; },
        async retire(consent) { calls.push('conflict-retire'); assert.equal(consent.subject, conflictSubject); return { protocol: 'devbridge/setup-resource-conflict-retirement-v1', ready: true, changed: true, reason: null }; },
      }),
      consentStoreFactory: () => ({ async load() { return { protocol: 'devbridge/setup-resource-conflict-consent-v1', subject: conflictSubject }; } }),
    });
    const result = await configuration.reconcile({ revision: record.revision, subject: record.digest });
    assert.equal(result.changed, true);
    assert.deepEqual(calls.slice(0, 4), ['conflict-inspect', 'conflict-retire', 'storage', 'network']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected configuration rejects non-Windows and incomplete local topology', () => {
  assert.throws(() => createWindowsProtectedEnvironmentConfiguration({ stateDirectory: 'state', authorityDirectory: 'authority', platform: 'linux' }), /requires a Windows host/u);
  assert.throws(() => createWindowsProtectedEnvironmentConfiguration({ stateDirectory: 'state', platform: 'win32' }), /authorityDirectory/u);
});
