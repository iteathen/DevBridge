import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLinuxProtectedEnvironmentConfiguration } from '../src/app/linux-environment-configuration-host.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  EnvironmentProfileConfigurationRegistry,
} from '../src/runtime/environment-profile-configuration.js';
import {
  ENVIRONMENT_DECLARATION_PROTOCOL,
  EnvironmentDeclarationRegistry,
} from '../src/runtime/environment-declaration.js';

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

async function accepted() {
  let value = null;
  const registry = new EnvironmentProfileConfigurationRegistry({
    port: {
      async load() { return structuredClone(value); },
      async save(next) { value = structuredClone(next); },
    },
    now: () => '2026-08-29T12:00:00.000Z',
  });
  return (await registry.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations: [declaration()] })).record;
}

function keyedPort() {
  const values = new Map();
  return {
    async load(key) { return structuredClone(values.get(key) ?? null); },
    async save(key, value) { values.set(key, structuredClone(value)); },
    async scan() { return [...values.values()].map((entry) => structuredClone(entry)); },
  };
}

function foundationState() {
  let storage = false;
  let networking = false;
  return async ({ stateDirectory, platform }) => {
    assert.equal(stateDirectory, '/var/lib/devbridge/authority/state');
    assert.equal(platform, 'linux');
    return {
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
    };
  };
}

test('Linux protected configuration reconciles only an exact fixed-handoff subject', async () => {
  const record = await accepted();
  const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort() });
  const reads = [];
  const configuration = createLinuxProtectedEnvironmentConfiguration({
    stateDirectory: '/home/alice/.devbridge/state',
    authorityDirectory: '/var/lib/devbridge/authority/state',
    runDirectory: '/run/devbridge',
    platform: 'linux',
    serviceUserId: 991,
  }, {
    recordReader: async (request) => { reads.push(request); return record; },
    foundationFactory: foundationState(),
    lifecycleFactory: ({ stateDirectory }) => {
      assert.equal(stateDirectory, '/var/lib/devbridge/authority/state');
      return { declarations };
    },
  });
  const result = await configuration.reconcile({ revision: record.revision, subject: record.digest });
  assert.deepEqual(result, { ready: true, changed: true, revision: record.revision, subject: record.digest });
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0], {
    stateDirectory: '/home/alice/.devbridge/state',
    runDirectory: '/run/devbridge',
    serviceUserId: 991,
  });
  assert.equal((await declarations.list()).length, 1);
});

test('Linux protected configuration rejects handoff drift after effects', async () => {
  const record = await accepted();
  const declarations = new EnvironmentDeclarationRegistry({ port: keyedPort() });
  let reads = 0;
  const configuration = createLinuxProtectedEnvironmentConfiguration({
    stateDirectory: '/home/alice/.devbridge/state',
    authorityDirectory: '/var/lib/devbridge/authority/state',
    platform: 'linux',
    serviceUserId: 991,
  }, {
    recordReader: async () => {
      reads += 1;
      return reads === 1 ? record : { ...record, revision: 2 };
    },
    foundationFactory: foundationState(),
    lifecycleFactory: () => ({ declarations }),
  });
  await assert.rejects(
    configuration.reconcile({ revision: record.revision, subject: record.digest }),
    /subject changed/u,
  );
  assert.equal(reads, 2);
});

test('Linux protected configuration wrapper remains a narrow platform edge', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/app/linux-environment-configuration-host.js', import.meta.url)), 'utf8');
  for (const forbidden of ['Hyper-V', 'repositoryName', 'virtualMachineName', 'imagePath', 'credential', 'systemd', 'sudo', 'pkexec']) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'iu'));
  }
  assert.throws(() => createLinuxProtectedEnvironmentConfiguration({
    stateDirectory: '/state', authorityDirectory: '/authority', platform: 'win32', serviceUserId: 991,
  }), /requires a Linux host/u);
});
