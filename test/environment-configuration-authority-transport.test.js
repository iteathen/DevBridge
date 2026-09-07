import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createConfiguredEnvironmentConfigurationClient,
  createEnvironmentConfigurationSocketServer,
  environmentConfigurationAuthorityEndpoint,
  environmentConfigurationAuthorityIdentity,
} from '../src/runtime/environment-configuration-authority-transport.js';

test('configuration endpoint identity is deterministic and path-free', () => {
  const platform = 'win32';
  const first = environmentConfigurationAuthorityIdentity('C:\\Users\\Operator\\.devbridge\\state', { platform });
  const second = environmentConfigurationAuthorityIdentity('c:\\users\\operator\\.devbridge\\state', { platform });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{32}$/u);
  const endpoint = environmentConfigurationAuthorityEndpoint({ authorityIdentity: first, platform });
  assert.match(endpoint, /^\\\\\.\\pipe\\devbridge-environment-[0-9a-f]{32}-configuration-v1$/u);
  assert.doesNotMatch(endpoint, /Users|Operator|state/u);
});

test('configuration socket performs one bounded exact round trip', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-configuration-authority-'));
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const stateDirectory = platform === 'win32' ? path.join(root, 'state') : path.posix.join(root.replaceAll('\\', '/'), 'state');
  const runDirectory = platform === 'win32' ? undefined : path.posix.join(root.replaceAll('\\', '/'), 'run');
  let server;
  try {
    if (platform === 'linux') {
      const identity = environmentConfigurationAuthorityIdentity(stateDirectory, { platform });
      await mkdir(path.posix.join(runDirectory, identity, 'configuration'), { recursive: true });
    }
    server = createEnvironmentConfigurationSocketServer({
      stateDirectory,
      platform,
      ...(runDirectory ? { runDirectory } : {}),
      configuration: {
        async inspect() { return { ready: true }; },
        async reconcile(value) { return { ready: true, changed: true, ...value }; },
      },
    });
    await server.start();
    const client = createConfiguredEnvironmentConfigurationClient({
      stateDirectory,
      platform,
      ...(runDirectory ? { runDirectory } : {}),
      connectTimeoutMs: 3000,
    });
    const subject = 'c'.repeat(64);
    assert.deepEqual(await client.inspect(), { ready: true });
    assert.deepEqual(await client.reconcile({ revision: 4, subject }), { ready: true, changed: true, revision: 4, subject });
  } finally {
    await server?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('configuration client fails closed when the exact endpoint is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-configuration-absent-'));
  try {
    const platform = process.platform === 'win32' ? 'win32' : 'linux';
    const stateDirectory = platform === 'win32' ? path.join(root, 'state') : path.posix.join(root.replaceAll('\\', '/'), 'state');
    const client = createConfiguredEnvironmentConfigurationClient({
      stateDirectory,
      platform,
      ...(platform === 'linux' ? { runDirectory: path.posix.join(root.replaceAll('\\', '/'), 'run') } : {}),
      connectTimeoutMs: 100,
    });
    await assert.rejects(client.reconcile({ revision: 1, subject: 'd'.repeat(64) }), (error) => error.code === 'ENVIRONMENT_CONFIGURATION_AUTHORITY_UNAVAILABLE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
