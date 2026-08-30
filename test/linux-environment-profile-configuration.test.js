import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxEnvironmentProfileConfiguration } from '../src/setup/linux-environment-profile-configuration.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  EnvironmentProfileConfigurationRegistry,
} from '../src/runtime/environment-profile-configuration.js';
import { readFile } from 'node:fs/promises';
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

async function accepted({ declarations = [declaration()] } = {}) {
  let value = null;
  const registry = new EnvironmentProfileConfigurationRegistry({
    port: {
      async load() { return structuredClone(value); },
      async save(next) { value = structuredClone(next); },
    },
    now: () => '2026-08-29T12:00:00.000Z',
  });
  return (await registry.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations })).record;
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

test('ordinary Linux inspection requires exact declarations and neutral protected resource readiness', async () => {
  const record = await accepted();
  const status = [{
    profile: 'profile-a',
    declarationRevision: 1,
    declarationDigest: environmentDeclarationDigest(record.configuration.declarations[0]),
  }];
  const requests = [];
  let ready = false;
  const configuration = createLinuxEnvironmentProfileConfiguration({
    stateDirectory: '/home/alice/.devbridge/state', platform: 'linux', runDirectory: '/run/devbridge', userId: 1000,
  }, {
    recordReader: async () => record,
    publisher: async () => { throw new Error('inspection must not publish'); },
    configurationFactory: () => { throw new Error('inspection must not attach configuration transport'); },
    resourceFactory: (request) => {
      requests.push(request);
      return { async inspect() { return { ready, identity: 'foundation-a', reason: ready ? null : 'unavailable' }; } };
    },
  });
  assert.deepEqual(await configuration.inspect({ client: { list: async () => status } }), {
    ready: false,
    changed: false,
    blocker: 'protected environment resources do not match accepted profile requirements',
  });
  ready = true;
  assert.deepEqual(await configuration.inspect({ client: { list: async () => status } }), { ready: true, changed: false, blocker: null });
  assert.deepEqual(requests, [
    { stateDirectory: '/home/alice/.devbridge/state', platform: 'linux', runDirectory: '/run/devbridge', connectTimeoutMs: 3_000 },
    { stateDirectory: '/home/alice/.devbridge/state', platform: 'linux', runDirectory: '/run/devbridge', connectTimeoutMs: 3_000 },
  ]);
});

test('ordinary Linux inspection fails closed on unavailable resource evidence', async () => {
  const record = await accepted();
  const status = [{
    profile: 'profile-a',
    declarationRevision: 1,
    declarationDigest: environmentDeclarationDigest(record.configuration.declarations[0]),
  }];
  for (const inspect of [
    async () => null,
    async () => ({ ready: 'forged' }),
    async () => { throw new Error('/private/provider/detail'); },
  ]) {
    const configuration = createLinuxEnvironmentProfileConfiguration({
      stateDirectory: '/state', platform: 'linux', userId: 1000,
    }, {
      recordReader: async () => record,
      resourceFactory: () => ({ inspect }),
    });
    const result = await configuration.inspect({ client: { list: async () => status } });
    assert.equal(result.ready, false);
    assert.equal(JSON.stringify(result).includes('/private'), false);
    assert.equal(JSON.stringify(result).includes('provider'), false);
  }
});

test('empty Linux configuration no-ops without attaching protected resources', async () => {
  const record = await accepted({ declarations: [] });
  let attached = false;
  const configuration = createLinuxEnvironmentProfileConfiguration({
    stateDirectory: '/state', platform: 'linux', userId: 1000,
  }, {
    recordReader: async () => record,
    resourceFactory: () => { attached = true; throw new Error('must not attach'); },
  });
  assert.deepEqual(await configuration.inspect({ client: { list: async () => { throw new Error('must not list'); } } }), {
    ready: true,
    changed: false,
    blocker: null,
  });
  assert.equal(attached, false);
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

test('Linux configuration composition contains no provider or execution topology', async () => {
  const source = (await readFile(new URL('../src/setup/linux-environment-profile-configuration.js', import.meta.url), 'utf8')).toLowerCase();
  for (const identity of ['hyper-v', 'libvirt', 'qemu', 'virsh', 'virtual-machine', 'domain', 'qcow2', 'vhdx', '/dev/', 'executable', 'argv', 'credential']) {
    assert.equal(source.includes(identity), false, identity);
  }
});
