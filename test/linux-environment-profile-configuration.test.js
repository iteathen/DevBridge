import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxEnvironmentProfileConfiguration } from '../src/setup/linux-environment-profile-configuration.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  EnvironmentProfileConfigurationRegistry,
} from '../src/runtime/environment-profile-configuration.js';
import { ENVIRONMENT_DECLARATION_PROTOCOL, environmentDeclarationDigest } from '../src/runtime/environment-declaration.js';

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

test('ordinary Linux setup publishes the exact record before sending only its subject', async () => {
  const record = await accepted();
  const reads = [];
  const publications = [];
  const requests = [];
  const configuration = createLinuxEnvironmentProfileConfiguration({
    stateDirectory: '/home/alice/.devbridge/state',
    platform: 'linux',
    runDirectory: '/run/devbridge',
    userId: 1000,
  }, {
    recordReader: async (request) => { reads.push(request); return record; },
    publisher: async (request) => {
      publications.push(request);
      return { ready: true, changed: true, revision: record.revision, subject: record.digest };
    },
    configurationFactory: (request) => {
      assert.deepEqual(request, {
        stateDirectory: '/home/alice/.devbridge/state',
        platform: 'linux',
        runDirectory: '/run/devbridge',
        connectTimeoutMs: 3_000,
      });
      return {
        async reconcile(value) {
          requests.push(value);
          return { ready: true, changed: false, revision: value.revision, subject: value.subject };
        },
      };
    },
  });
  assert.deepEqual(await configuration.reconcile(), { ready: true, changed: true, blocker: null });
  assert.equal(reads.length, 3);
  assert.deepEqual(publications, [{
    stateDirectory: '/home/alice/.devbridge/state',
    runDirectory: '/run/devbridge',
    userId: 1000,
    record,
  }]);
  assert.deepEqual(requests, [{ revision: record.revision, subject: record.digest }]);
});

test('ordinary Linux inspection verifies declarations without inventing a neighboring resource endpoint', async () => {
  const record = await accepted();
  const status = [{
    profile: 'profile-a',
    declarationRevision: 1,
    declarationDigest: environmentDeclarationDigest(record.configuration.declarations[0]),
  }];
  const configuration = createLinuxEnvironmentProfileConfiguration({
    stateDirectory: '/home/alice/.devbridge/state', platform: 'linux', userId: 1000,
  }, {
    recordReader: async () => record,
    publisher: async () => { throw new Error('inspection must not publish'); },
    configurationFactory: () => { throw new Error('inspection must not attach configuration transport'); },
  });
  assert.deepEqual(await configuration.inspect({ client: { list: async () => status } }), { ready: true, changed: false, blocker: null });
});

test('ordinary Linux setup rejects publication or accepted-state drift before protected reconciliation', async () => {
  const record = await accepted();
  let configurationCalls = 0;
  const factory = () => { configurationCalls += 1; return { reconcile: async () => ({ ready: true }) }; };
  const badPublication = createLinuxEnvironmentProfileConfiguration({
    stateDirectory: '/state', platform: 'linux', userId: 1000,
  }, {
    recordReader: async () => record,
    publisher: async () => ({ ready: true, changed: false, revision: 2, subject: record.digest }),
    configurationFactory: factory,
  });
  await assert.rejects(badPublication.reconcile(), /publication evidence changed/u);
  assert.equal(configurationCalls, 0);

  let reads = 0;
  const drift = createLinuxEnvironmentProfileConfiguration({
    stateDirectory: '/state', platform: 'linux', userId: 1000,
  }, {
    recordReader: async () => {
      reads += 1;
      return reads === 1 ? record : { ...record, revision: 2 };
    },
    publisher: async () => ({ ready: true, changed: false, revision: record.revision, subject: record.digest }),
    configurationFactory: factory,
  });
  await assert.rejects(drift.reconcile(), /subject changed/u);
  assert.equal(configurationCalls, 0);
});

test('Linux configuration adapter rejects a foreign platform before attaching ports', () => {
  assert.throws(() => createLinuxEnvironmentProfileConfiguration({
    stateDirectory: '/state', platform: 'win32', userId: 1000,
  }), /requires a Linux host/u);
});
