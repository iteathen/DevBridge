import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWindowsGuestImagePayload } from '../src/guest/windows-image-payload.js';
import { createDefaultWindowsToolchainAuthority } from '../src/setup/windows-toolchain-authority.js';
import {
  createWindowsProductionImagePhysicalCanary,
} from '../src/app/windows-production-image-physical-canary.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-physical-canary-'));
  const sourceLocation = path.join(root, 'Windows.iso');
  await writeFile(sourceLocation, 'approved-media');
  const payload = await createWindowsGuestImagePayload();
  const sha256 = 'a'.repeat(64);
  return {
    root,
    payload,
    config: {
      protocol: 'devbridge/windows-production-image-physical-canary-config-v1',
      stateDirectory: path.join(root, 'state'),
      sourceLocation,
      authority: {
        protocol: 'devbridge/windows-production-image-authority-v1',
        media: {
          protocol: 'devbridge/windows-install-media-authority-v1',
          media: { name: 'Windows.iso', bytes: 14, sha256 },
          approval: { sourceClass: 'official-owned', expectedSha256: sha256, reference: 'https://www.microsoft.com/en-us/software-download/windows11', temporary: false },
          image: { container: 'wim', index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', version: '10.0.26100.1', build: 26100, installationType: 'Client', languages: ['en-US'], defaultLanguage: 'en-US' },
        },
        tools: createDefaultWindowsToolchainAuthority(),
        payload: { generation: payload.generation },
        recipe: { generation: 'audit-handoff-v1' },
        output: { profile: 'windows-build', generation: 'windows-production-v1', bootstrap: payload.generation },
      },
      resources: { memoryBytes: 4 * 1024 ** 3, processorCount: 2, diskBytes: 64 * 1024 ** 3, allocationBytes: 40 * 1024 ** 3 },
    },
  };
}

function readyPreflight(calls = []) {
  return {
    async inspect(request) {
      calls.push(structuredClone(request));
      return { protocol: 'test/preflight-v1', ready: true, reason: null, capabilities: { provider: true, connectivity: true, memory: true, storage: true }, resources: {} };
    },
  };
}

test('Windows physical canary status is read-only and reports exact unregistered readiness', async () => {
  const data = await fixture();
  let runtimes = 0;
  const preflightCalls = [];
  try {
    const canary = createWindowsProductionImagePhysicalCanary(data.config, {
      platform: 'win32',
      payloadFactory: async () => data.payload,
      preflight: readyPreflight(preflightCalls),
      runtimeFactory: async () => { runtimes += 1; throw new Error('must not create runtime'); },
    });
    const status = await canary.status();
    assert.equal(status.state, 'absent');
    assert.equal(status.blocked, false);
    assert.equal(status.authorityRegistered, false);
    assert.equal(runtimes, 0);
    assert.equal(preflightCalls.length, 1);
    assert.equal(preflightCalls[0].sourceBytes, 14);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('Windows physical canary blocks missing approved source before authority or runtime mutation', async () => {
  const data = await fixture();
  let runtimes = 0;
  try {
    await rm(data.config.sourceLocation);
    const canary = createWindowsProductionImagePhysicalCanary(data.config, {
      platform: 'win32', payloadFactory: async () => data.payload, preflight: readyPreflight(), runtimeFactory: async () => { runtimes += 1; },
    });
    const result = await canary.run();
    assert.equal(result.blocked, true);
    assert.match(result.reason, /approved source media file is unavailable/u);
    assert.equal(result.authorityRegistered, false);
    assert.equal(runtimes, 0);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('Windows physical canary binds the exact request and advances only after operation-channel readiness', async () => {
  const data = await fixture();
  let current = { phase: 'active', complete: false, blocked: false, reason: null, image: null };
  const calls = [];
  try {
    const canary = createWindowsProductionImagePhysicalCanary(data.config, {
      platform: 'win32', payloadFactory: async () => data.payload, preflight: readyPreflight(),
      runtimeFactory: async ({ request, subject }) => {
        calls.push(['request', structuredClone(request)]);
        return {
          canary: {
            async inspect() { return structuredClone(current); },
            async advance() { calls.push(['advance']); current = { phase: 'completed', complete: true, blocked: false, reason: null, image: { identity: 'img-123' } }; return structuredClone(current); },
          },
          construction: { async status(identity) { assert.equal(identity, subject); return { identity, state: 'running', mediaCount: 0, uptimeMilliseconds: 10_000 }; } },
          async readiness(identity) { calls.push(['readiness', identity]); return { ready: true, reason: null }; },
          async cleanupTransient() { calls.push(['cleanup']); },
          accessMaterial: { async discard(identity) { calls.push(['discard', identity]); return { discarded: true }; } },
        };
      },
    });
    const result = await canary.run();
    assert.equal(result.complete, true);
    assert.equal(result.authorityRegistered, true);
    const request = calls.find(([name]) => name === 'request')[1];
    assert.equal(request.check.build, 26100);
    assert.equal(request.check.edition, 'Professional');
    assert.equal(request.check.nodeVersion, '22.23.2');
    assert.equal(request.check.sourceControlVersion, '2.55.0.windows.5');
    assert.equal(request.check.nativeBuildVersion, '17.14.37614.0');
    assert.deepEqual(calls.map(([name]) => name), ['request', 'cleanup', 'readiness', 'advance', 'cleanup', 'discard']);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('Windows physical canary waits without advancing when noninteractive guest access is not ready', async () => {
  const data = await fixture();
  let advances = 0;
  try {
    const canary = createWindowsProductionImagePhysicalCanary(data.config, {
      platform: 'win32', payloadFactory: async () => data.payload, preflight: readyPreflight(), now: () => new Date('2026-08-28T12:00:00.000Z'),
      runtimeFactory: async ({ subject }) => ({
        canary: { async inspect() { return { phase: 'active', complete: false, blocked: false, reason: null, image: null }; }, async advance() { advances += 1; } },
        construction: { async status() { return { identity: subject, state: 'running', mediaCount: 0, uptimeMilliseconds: 30_000 }; } },
        async readiness() { return { ready: false, reason: 'guest operation channel is not ready' }; },
        async cleanupTransient() {},
      }),
    });
    const result = await canary.run();
    assert.equal(result.state, 'waiting');
    assert.match(result.reason, /operation channel is not ready/u);
    assert.equal(advances, 0);
  } finally { await rm(data.root, { recursive: true, force: true }); }
});

test('Windows physical canary topology does not admit remote, project, or model identities', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/app/windows-production-image-physical-canary.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /GitHub|repository[A-Z]|pull request|Codex|CUDA/iu);
});
