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

async function accepted(root) {
  const registry = new EnvironmentProfileConfigurationRegistry({
    port: createEnvironmentProfileConfigurationStateStore(path.join(root, 'environment-profile-configuration', 'state.json')),
  });
  return (await registry.publish({ protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL, declarations: [declaration()] })).record;
}

test('ordinary setup sends only the exact accepted configuration subject to protected reconciliation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-configuration-'));
  try {
    const record = await accepted(root);
    const requests = [];
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' }, {
      configurationFactory: () => ({
        async reconcile(value) {
          requests.push(value);
          return { ready: true, changed: true, revision: value.revision, subject: value.subject };
        },
      }),
    });
    assert.deepEqual(await configuration.reconcile(), { ready: true, changed: true, blocker: null });
    assert.deepEqual(requests, [{ revision: record.revision, subject: record.digest }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary setup rejects protected evidence for another accepted subject', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-subject-'));
  try {
    await accepted(root);
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' }, {
      configurationFactory: () => ({
        async reconcile(value) { return { ready: true, changed: false, revision: value.revision, subject: 'f'.repeat(64) }; },
      }),
    });
    await assert.rejects(configuration.reconcile(), /evidence changed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary inspection requires protected resource readiness as well as exact declarations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-profile-resources-'));
  try {
    const record = await accepted(root);
    const status = [{
      profile: 'profile-a',
      declarationRevision: 1,
      declarationDigest: environmentDeclarationDigest(record.configuration.declarations[0]),
    }];
    let networking = false;
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32' }, {
      activityFactory: () => ({
        async inspect() { return { ready: networking, identity: 'foundation-a', reason: networking ? null : 'unavailable' }; },
      }),
    });
    assert.equal((await configuration.inspect({ client: { list: async () => status } })).ready, false);
    networking = true;
    assert.equal((await configuration.inspect({ client: { list: async () => status } })).ready, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configuration intake rejects ordinary filesystem indirection', async (t) => {
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

test('configuration intake rejects an unbounded ordinary state file before parsing', async () => {
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

test('non-Windows composition has no configuration endpoint dependency', async () => {
  const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: '/state', platform: 'linux' }, {
    recordReader: async () => { throw new Error('must not read'); },
    activityFactory: () => { throw new Error('must not attach'); },
    configurationFactory: () => { throw new Error('must not attach'); },
  });
  assert.deepEqual(await configuration.inspect(), { ready: true, changed: false, blocker: null });
  assert.deepEqual(await configuration.reconcile(), { ready: true, changed: false, blocker: null });
});
