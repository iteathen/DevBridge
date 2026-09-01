import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSetupEnvironmentProfileConfiguration } from '../src/app/setup-environment-profile-configuration.js';
import { BaseImageLibrary } from '../src/runtime/base-image-library.js';
import { executionWorkspaceIdentity } from '../src/app/execution-profile-routing.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  EnvironmentProfileConfigurationRegistry,
} from '../src/runtime/environment-profile-configuration.js';
import { ENVIRONMENT_DECLARATION_PROTOCOL } from '../src/runtime/environment-declaration.js';
import { createEnvironmentProfileConfigurationStateStore } from '../src/state/environment-profile-configuration-state-store.js';
import { createUbuntuEnvironmentProfileSource } from '../src/setup/ubuntu-environment-profile-source.js';

const COMPOSITION = new URL('../src/app/setup-environment-profile-configuration.js', import.meta.url);

function configuration(root, now = null) {
  return createSetupEnvironmentProfileConfiguration({
    stateDirectory: root,
    sources: [createUbuntuEnvironmentProfileSource()],
    identify: executionWorkspaceIdentity,
    ...(now ? { now } : {}),
  });
}

test('setup projects stable subjects into one accepted profile without repository names', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-profile-configuration-'));
  try {
    const source = path.join(root, 'source.vhdx');
    await writeFile(source, 'bounded-image');
    const images = new BaseImageLibrary({ directory: path.join(root, 'environment-foundation', 'images') });
    const image = await images.publish({
      profile: 'linux-development',
      generation: 'ubuntu-2604-production-v6',
      source,
      provenance: { origin: 'test', bootstrap: 'guest-image-v1' },
    });
    const setup = configuration(root, () => '2026-08-28T12:00:00.000Z');
    const first = await setup.reconcile({ subjects: [{ id: 42, fullName: 'must/not-cross' }, { id: 7, private: true }] });
    const declaration = first.record.configuration.declarations[0];
    assert.equal(declaration.image.identity, image.identity);
    assert.deepEqual(declaration.workspaces, [
      { identity: executionWorkspaceIdentity('42', 'linux-development'), authority: '42' },
      { identity: executionWorkspaceIdentity('7', 'linux-development'), authority: '7' },
    ]);
    assert.equal(JSON.stringify(first.record).includes('must/not-cross'), false);

    await images.retire(image.identity);
    const second = await setup.reconcile({ subjects: [{ id: 7 }] });
    assert.equal(second.record.configuration.declarations[0].image.identity, image.identity);
    assert.deepEqual(second.record.configuration.declarations[0].workspaces, [
      { identity: executionWorkspaceIdentity('7', 'linux-development'), authority: '7' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup refuses to preserve an obsolete accepted image generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-profile-generation-'));
  try {
    const registry = new EnvironmentProfileConfigurationRegistry({
      port: createEnvironmentProfileConfigurationStateStore(path.join(root, 'environment-profile-configuration', 'state.json')),
      now: () => '2026-08-28T12:00:00.000Z',
    });
    await registry.publish({
      protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
      declarations: [{
        protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
        profile: 'linux-development',
        schemaGeneration: 'linux-development-v1',
        guest: { family: 'ubuntu', generation: '26.04' },
        image: { identity: 'image-obsolete', generation: 'ubuntu-obsolete' },
        resources: { memoryBytes: 2_147_483_648, processorCount: 2 },
        boot: { requirement: 'efi-v1' },
        network: { requirement: 'managed-egress-v1' },
        bootstrap: { generation: 'guest-image-v1', requirements: ['compiler-c'] },
        enrollment: { requirement: 'unique-guest-trust-v1' },
        workspaces: [],
        protectedStateClasses: [],
      }],
    });
    const setup = configuration(root);
    await assert.rejects(setup.reconcile(), /no longer matches current output authority/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup profile publication remains isolated from platform and provider identities', async () => {
  const source = await readFile(COMPOSITION, 'utf8');
  assert.doesNotMatch(source, /\b(?:windows|linux|ubuntu|hyper-v|libvirt|vhdx|qcow2)\b/iu);
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:ubuntu|windows|providers)[^'"]*['"]/iu);
});
