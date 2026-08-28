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
    const configuration = createWindowsEnvironmentProfileConfiguration({ stateDirectory: root, platform: 'win32', invoke: async () => {} }, {
      adoptImages: async () => { adoptions += 1; return { ready: true }; },
      foundationFactory: async () => ({
        async listImages() { return [{ identity: 'image-a', profile: 'profile-a', generation: 'image-v1', retiredAt: null }]; },
        async verifyImage(identity) { return { identity, usable: true, verified: true }; },
      }),
      lifecycleFactory: () => ({ declarations }),
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
    const status = [{ profile: record.declaration.profile, declarationRevision: record.revision, declarationDigest: environmentDeclarationDigest(record.declaration) }];
    assert.equal((await configuration.inspect({ client: { list: async () => status } })).ready, true);
    assert.equal((await configuration.reconcile({ plan })).changed, false);
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
