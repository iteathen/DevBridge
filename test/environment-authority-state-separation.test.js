import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentBootstrap } from '../src/app/environment-bootstrap.js';
import { createLocalEnvironmentAccess } from '../src/app/environment-construction-preparation.js';
import { createEnvironmentConstructionRuntime } from '../src/app/environment-construction-runtime.js';
import { ENVIRONMENT_DECLARATION_PROTOCOL } from '../src/runtime/environment-declaration.js';

function declaration() {
  return {
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: 'linux-development',
    schemaGeneration: 'profile-v1',
    guest: { family: 'ubuntu', generation: '24.04.4' },
    image: { identity: 'image-ubuntu-2404-v1', generation: 'ubuntu-24.04.4-v1' },
    resources: { memoryBytes: 4294967296, processorCount: 4 },
    boot: { requirement: 'efi-v1' },
    network: { requirement: 'managed-egress-v1' },
    bootstrap: { generation: 'tooling-v1', requirements: ['runtime-js'] },
    enrollment: { requirement: 'unique-guest-trust-v1' },
    workspaces: [],
    protectedStateClasses: [],
  };
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

const noProviderInvoke = async () => {
  throw new Error('provider invocation is not expected during authority-state composition');
};

async function compose(stateDirectory, authorityDirectory = null) {
  return createEnvironmentConstructionRuntime({
    stateDirectory,
    ...(authorityDirectory == null ? {} : { authorityDirectory }),
    availability: { ensure: async () => ({ ready: true }) },
    resolveAuthority: async () => '42',
    invoke: noProviderInvoke,
  });
}

async function materializeAuthorityState(runtime) {
  await runtime.lifecycle.declarations.register(declaration());
  await runtime.pipeline.clear('authority-state-probe');
}

test('explicit authorityDirectory owns foundation, lifecycle, and construction checkpoint state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-state-'));
  const stateDirectory = path.join(root, 'ordinary');
  const authorityDirectory = path.join(root, 'protected');
  try {
    const runtime = await compose(stateDirectory, authorityDirectory);
    await materializeAuthorityState(runtime);

    assert.equal(await exists(path.join(authorityDirectory, 'environment-foundation', 'identity.json')), true);
    assert.equal(await exists(path.join(authorityDirectory, 'environment-lifecycle', 'state.json')), true);
    assert.equal(await exists(path.join(authorityDirectory, 'environment-construction', 'state.json')), true);

    assert.equal(await exists(path.join(stateDirectory, 'environment-foundation')), false);
    assert.equal(await exists(path.join(stateDirectory, 'environment-lifecycle')), false);
    assert.equal(await exists(path.join(stateDirectory, 'environment-construction')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows access and bootstrap reuse protected foundation identity without recreating it in ordinary state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-preparation-'));
  const stateDirectory = path.join(root, 'ordinary');
  const authorityDirectory = path.join(root, 'protected');
  try {
    await createLocalEnvironmentAccess({
      stateDirectory,
      authorityDirectory,
      platform: 'win32',
      invoke: noProviderInvoke,
      guest: { family: 'ubuntu', generation: '24.04.4' },
    });
    await createEnvironmentBootstrap({
      stateDirectory,
      authorityDirectory,
      platform: 'win32',
      invoke: noProviderInvoke,
      access: async () => ({ family: 'linux' }),
      requirements: ['runtime-js'],
    });

    assert.equal(await exists(path.join(authorityDirectory, 'environment-foundation', 'identity.json')), true);
    assert.equal(await exists(path.join(stateDirectory, 'environment-foundation')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('omitted authorityDirectory preserves the existing single-root state layout', async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-default-'));
  try {
    const runtime = await compose(stateDirectory);
    await materializeAuthorityState(runtime);

    assert.equal(await exists(path.join(stateDirectory, 'environment-foundation', 'identity.json')), true);
    assert.equal(await exists(path.join(stateDirectory, 'environment-lifecycle', 'state.json')), true);
    assert.equal(await exists(path.join(stateDirectory, 'environment-construction', 'state.json')), true);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('authorityDirectory rejects empty non-null values', async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-authority-invalid-'));
  try {
    await assert.rejects(
      compose(stateDirectory, ''),
      /authorityDirectory must be a non-empty string/u,
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
