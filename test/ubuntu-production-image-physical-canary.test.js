import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGuestImagePayload } from '../src/guest/image-payload.js';
import {
  createUbuntuProductionImagePhysicalCanary,
  UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL,
} from '../src/app/ubuntu-production-image-physical-canary.js';

async function fixture(root) {
  const payload = await createGuestImagePayload();
  const sourceSha256 = 'a'.repeat(64);
  return {
    payload,
    config: {
      protocol: UBUNTU_PRODUCTION_IMAGE_PHYSICAL_CANARY_CONFIG_PROTOCOL,
      stateDirectory: path.join(root, 'state'),
      keyring: path.join(root, 'archive-keyring.gpg'),
      authority: {
        protocol: 'devbridge/ubuntu-construction-authority-v1',
        source: {
          protocol: 'devbridge/ubuntu-release-media-v1',
          release: '26.04',
          architecture: 'amd64',
          media: {
            url: 'https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso',
            name: 'ubuntu-26.04-live-server-amd64.iso',
            sha256: sourceSha256,
            bytes: 3_145_728_000,
          },
          checksums: {
            manifestUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS',
            signatureUrl: 'https://releases.ubuntu.com/26.04/SHA256SUMS.gpg',
            signerFingerprint: 'A'.repeat(40),
          },
        },
        recipe: {
          protocol: 'devbridge/ubuntu-autoinstall-recipe-v1',
          sourceSha256,
          generation: 'ubuntu-2604-autoinstall-v1',
          patches: [{ id: 'boot-trigger', occurrences: 2, before: 'install ---', after: 'auto    ---' }],
        },
        packages: {
          generation: 'ubuntu-2604-tools-v1',
          packages: [
            { name: 'build-essential', version: '12.12ubuntu1' },
            { name: 'cmake', version: '3.31.6-1' },
            { name: 'git', version: '1:2.48.1-0ubuntu1' },
            { name: 'nodejs', version: '22.16.0+dfsg-1' },
            { name: 'npm', version: '10.9.2+ds-1' },
          ],
        },
        payload: { generation: payload.generation },
        qualification: { commands: ['make'] },
        output: { profile: 'linux-development', generation: 'ubuntu-2604-production-v1', bootstrap: 'guest-image-v1' },
      },
      resources: { memoryBytes: 2 * 1024 * 1024 * 1024, processorCount: 2, diskBytes: 32 * 1024 * 1024 * 1024 },
    },
  };
}

const readyPreflight = Object.freeze({
  async inspect() {
    return Object.freeze({ protocol: 'test/preflight-v1', ready: true, reason: null, capabilities: Object.freeze({ provider: true, keyring: true, memory: true, storage: true }), resources: Object.freeze({}) });
  },
});

function status(phase, { complete = false, blocked = false, reason = null, image = null } = {}) {
  return Object.freeze({ protocol: 'devbridge/canonical-image-canary-v1', identity: `subject-${'1'.repeat(32)}`, phase, revision: 1, complete, blocked, reason, image });
}

async function absent(value) {
  try { await lstat(value); return false; }
  catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

test('physical canary status is genuinely non-mutating before host admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-status-'));
  try {
    const data = await fixture(root);
    let runtimeCalls = 0;
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, {
      platform: 'win32',
      preflight: readyPreflight,
      payloadFactory: async () => data.payload,
      runtimeFactory: async () => { runtimeCalls += 1; throw new Error('runtime must not be created by status'); },
    });
    const result = await canary.status();
    assert.equal(result.state, 'absent');
    assert.equal(result.blocked, false);
    assert.equal(result.authorityRegistered, false);
    assert.equal(runtimeCalls, 0);
    assert.equal(await absent(data.config.stateDirectory), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary run returns waiting while unattended installation owns the frontier', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-install-'));
  try {
    const data = await fixture(root);
    let advances = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('running'), identity: subject }; },
        async advance() { advances += 1; throw new Error('installer frontier must not advance'); },
      },
      construction: { async status() { return { identity: subject, phase: 'installing', state: 'running', mediaCount: 2 }; } },
      accessProbe: { async inspect() { return { ready: true }; } },
      async access() { throw new Error('access must not be probed during installation'); },
      addressOwner: { async releaseAddress() {} },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory });
    const result = await canary.run();
    assert.equal(result.state, 'waiting');
    assert.match(result.reason, /installer is still running/u);
    assert.equal(advances, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary run waits for exact SSH access before qualification', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-access-'));
  try {
    const data = await fixture(root);
    let advances = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('active'), identity: subject }; },
        async advance() { advances += 1; throw new Error('qualification must not start without access'); },
      },
      construction: { async status() { return { identity: subject, phase: 'qualifying', state: 'running', mediaCount: 0 }; } },
      accessProbe: { async inspect() { return { ready: false, reason: 'host key not ready' }; } },
      async access() { return { family: 'linux', user: 'devbridge', address: '192.168.90.20', identityFile: 'id', knownHostsFile: 'known' }; },
      addressOwner: { async releaseAddress() {} },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory });
    const result = await canary.run();
    assert.equal(result.state, 'waiting');
    assert.match(result.reason, /host key not ready/u);
    assert.equal(advances, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary run waits for sanitizer shutdown before qualified acceptance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-shutdown-'));
  try {
    const data = await fixture(root);
    let advances = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('finalized'), identity: subject }; },
        async advance() { advances += 1; throw new Error('acceptance must not race shutdown'); },
      },
      construction: { async status() { return { identity: subject, phase: 'qualifying', state: 'running', mediaCount: 0 }; } },
      accessProbe: { async inspect() { return { ready: true }; } },
      async access() { return {}; },
      addressOwner: { async releaseAddress() {} },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory });
    const result = await canary.run();
    assert.equal(result.state, 'waiting');
    assert.match(result.reason, /powering off/u);
    assert.equal(advances, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary completed state releases only its reserved network address', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-complete-'));
  try {
    const data = await fixture(root);
    let releases = 0;
    const runtimeFactory = async ({ subject }) => ({
      canary: {
        async inspect() { return { ...status('completed', { complete: true, image: { identity: `img-${'2'.repeat(32)}` } }), identity: subject }; },
        async advance() { throw new Error('completed canary must not advance'); },
      },
      construction: { async status() { throw new Error('completed canary must not inspect construction'); } },
      accessProbe: { async inspect() { throw new Error('completed canary must not probe access'); } },
      async access() { throw new Error('completed canary must not resolve access'); },
      addressOwner: { async releaseAddress(value) { assert.equal(value, subject); releases += 1; } },
    });
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, { platform: 'win32', preflight: readyPreflight, payloadFactory: async () => data.payload, runtimeFactory });
    const result = await canary.run();
    assert.equal(result.state, 'completed');
    assert.equal(releases, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('physical canary blocks code-payload drift before host mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-physical-canary-drift-'));
  try {
    const data = await fixture(root);
    let runtimeCalls = 0;
    const changed = { ...data.payload, generation: 'guest-image-ffffffffffffffffffffffff' };
    const canary = createUbuntuProductionImagePhysicalCanary(data.config, {
      platform: 'win32',
      preflight: readyPreflight,
      payloadFactory: async () => changed,
      runtimeFactory: async () => { runtimeCalls += 1; throw new Error('drifted runtime must not start'); },
    });
    const result = await canary.run();
    assert.equal(result.state, 'blocked');
    assert.match(result.reason, /payload generation/u);
    assert.equal(runtimeCalls, 0);
    assert.equal(await absent(data.config.stateDirectory), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
