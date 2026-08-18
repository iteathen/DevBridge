import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { discoverPathTools, choosePreferredAvailable } from '../src/runtime/tool-discovery.js';
import { ToolInventoryService } from '../src/runtime/tool-inventory.js';
import { ToolInventoryProjector } from '../src/github/tool-inventory-projector.js';

async function fakeExecutable(directory, name) {
  const actual = process.platform === 'win32' ? `${name}.EXE` : name;
  await writeFile(path.join(directory, actual), '', { mode: 0o755 });
}

function fakeSandbox(verified = false) {
  return {
    inspect: () => ({
      provider: verified ? 'fixture' : 'none',
      configured: verified,
      verified,
      verification: verified ? 'fixture-passed' : 'unavailable',
      filesystem: verified ? 'verified' : 'unverified',
      network: verified ? 'verified-deny' : 'unverified',
      identityBoundary: verified ? 'verified' : 'unverified',
    }),
  };
}

test('PATH discovery is bounded, avoids version subprocesses by default, and supports preferred fallbacks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-tool-discovery-'));
  try {
    await fakeExecutable(directory, 'rg');
    await fakeExecutable(directory, 'git');
    const env = process.platform === 'win32'
      ? { Path: directory, PATHEXT: '.EXE;.CMD' }
      : { PATH: directory };
    const registry = await discoverPathTools({
      env,
      catalog: [
        { command: 'rg', category: 'code-search' },
        { command: 'grep', category: 'code-search' },
        { command: 'git', category: 'vcs' },
      ],
      probeVersions: false,
    });
    assert.equal(registry.tools.find((entry) => entry.name === 'rg').available, true);
    assert.equal(registry.tools.find((entry) => entry.name === 'grep').available, false);
    assert.equal(choosePreferredAvailable(registry, ['grep', 'rg']), 'rg');
    assert.equal(choosePreferredAvailable(registry, ['missing']), null);
    assert.ok(registry.discoveryElapsedMs < 50, `discovery took ${registry.discoveryElapsedMs} ms`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tool inventory separates local registration from verified usability and never publishes executable paths', async () => {
  const operationRegistry = {
    describe: ({ sandboxStatus }) => [
      { name: 'node.syntax-check', executionClass: 'static-inspection', sandboxRequirement: 'none', usable: true },
      { name: 'node.test', executionClass: 'repository-code', sandboxRequirement: 'verified', usable: sandboxStatus.verified === true },
    ],
  };
  const toolchainRegistry = {
    inspect: async () => [{
      name: 'node', family: 'node', available: true, layer: 'core', version: process.version,
      source: 'process.execPath', executable: '/SECRET/HOST/PATH/node', linkerExecutable: '/SECRET/HOST/PATH/link',
    }],
  };
  const profiles = {
    deterministic: {
      executable: process.execPath,
      args: [],
      inputMode: 'none',
      environment: { pass: [], set: {} },
      sandbox: { enforcement: 'none', requiresVerifiedSandbox: true, outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' },
    },
    model: {
      executable: process.execPath,
      args: [],
      inputMode: 'none',
      environment: { pass: [], set: {} },
      sandbox: { enforcement: 'none', requiresVerifiedSandbox: true, outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' },
    },
  };
  const service = new ToolInventoryService({
    operationRegistry,
    toolchainRegistry,
    sandboxProvider: fakeSandbox(false),
    profiles,
    deterministicProfileNames: ['deterministic'],
    modelAdaptersEnabled: false,
    env: process.env,
    discoverPathToolsEnabled: false,
  });
  const first = await service.refresh();
  const second = await service.refresh();
  assert.equal(second.digest, first.digest);
  assert.equal(second.generation, first.generation);
  assert.equal(first.inventory.operations.find((entry) => entry.name === 'node.test').usable, false);
  assert.equal(first.inventory.adapters.find((entry) => entry.name === 'deterministic').enabled, true);
  assert.equal(first.inventory.adapters.find((entry) => entry.name === 'deterministic').usable, false);
  assert.equal(first.inventory.adapters.find((entry) => entry.name === 'model').enabled, false);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /SECRET\/HOST\/PATH/u);
  assert.doesNotMatch(serialized, /"executable"/u);
  assert.doesNotMatch(serialized, /"linkerExecutable"/u);
});

test('verified sandbox status changes inventory digest and makes registered deterministic adapters usable', async () => {
  const operationRegistry = { describe: ({ sandboxStatus }) => [{ name: 'node.test', executionClass: 'repository-code', sandboxRequirement: 'verified', usable: sandboxStatus.verified }] };
  const toolchainRegistry = { inspect: async () => [] };
  let verified = false;
  const sandboxProvider = { inspect: () => fakeSandbox(verified).inspect() };
  const service = new ToolInventoryService({
    operationRegistry, toolchainRegistry, sandboxProvider,
    profiles: { deterministic: { executable: process.execPath, args: [], inputMode: 'none', environment: { pass: [], set: {} }, sandbox: { enforcement: 'none', requiresVerifiedSandbox: true } } },
    deterministicProfileNames: ['deterministic'],
    discoverPathToolsEnabled: false,
  });
  const first = await service.refresh();
  verified = true;
  const second = await service.refresh();
  assert.notEqual(second.digest, first.digest);
  assert.equal(second.generation, first.generation + 1);
  assert.equal(second.inventory.operations[0].usable, true);
  assert.equal(second.inventory.adapters[0].usable, true);
});

test('GitHub inventory projection coalesces unchanged digests and updates one stable comment', async () => {
  const state = new Map();
  const calls = [];
  const stateStore = { get: async (key) => state.get(key), set: async (key, value) => state.set(key, value) };
  const client = {
    request: async (method, requestPath, options = {}) => {
      calls.push({ method, requestPath, options });
      if (method === 'GET') return { data: [], headers: {} };
      if (method === 'POST') return { data: { id: 701 } };
      if (method === 'PATCH') return { data: { id: 701 } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const projector = new ToolInventoryProjector({ client, stateStore, queueRepository: 'iteathen/PATCH-POLLER' });
  const record = { protocol: 'patch-poller/tool-inventory-record-v1', digest: 'a'.repeat(64), generation: 1, generatedAt: '2026-08-18T20:00:00Z', inventory: { protocol: 'patch-poller/tool-inventory-v1', tools: [] } };
  const first = await projector.project({ issueNumber: 31, record });
  const second = await projector.project({ issueNumber: 31, record });
  assert.equal(first.projected, true);
  assert.equal(second.projected, false);
  assert.equal(second.reason, 'unchanged');
  assert.equal(calls.filter((entry) => entry.method === 'POST').length, 1);

  const changed = { ...record, digest: 'b'.repeat(64), generation: 2 };
  await projector.project({ issueNumber: 31, record: changed });
  assert.equal(calls.filter((entry) => entry.method === 'PATCH').length, 1);
});

test('inventory projection refuses secret-bearing content rather than redacting a digest-bound payload', async () => {
  const projector = new ToolInventoryProjector({
    client: { request: async () => { throw new Error('must not publish'); } },
    stateStore: { get: async () => null, set: async () => {} },
    queueRepository: 'iteathen/PATCH-POLLER',
    secretValues: ['super-secret-token'],
  });
  const record = {
    protocol: 'patch-poller/tool-inventory-record-v1', digest: 'a'.repeat(64), generation: 1,
    inventory: { protocol: 'patch-poller/tool-inventory-v1', accidental: 'super-secret-token' },
  };
  await assert.rejects(projector.project({ issueNumber: 31, record }), /refusing to publish a redacted payload/u);
});
