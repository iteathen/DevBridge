import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { discoverPathTools, choosePreferredAvailable } from '../src/runtime/tool-discovery.js';
import { ToolInventoryService } from '../src/runtime/tool-inventory.js';
import { ToolInventoryProjector } from '../src/github/tool-inventory-projector.js';
import { IssueStatusReporter } from '../src/github/issue-status-reporter.js';

async function fakeExecutable(directory, name) {
  const actual = process.platform === 'win32' ? `${name}.EXE` : name;
  await writeFile(path.join(directory, actual), '', { mode: 0o755 });
}

function fakeSandbox(verified = false) {
  return {
    requestedProvider: verified ? 'fixture' : 'auto',
    provider: verified ? 'fixture' : 'none',
    platform: process.platform,
    available: verified,
    verified,
    verification: verified ? 'fixture-passed' : 'unavailable',
    repositoryCodeExecution: verified,
    filesystem: verified ? 'verified-boundary' : 'unverified',
    network: verified ? 'verified-deny' : 'unverified',
    gitAdministrativeState: verified ? 'read-only' : 'unverified',
    processTree: verified ? 'isolated' : 'unverified',
  };
}

function profile(executable = process.execPath) {
  return {
    executable,
    args: [],
    inputMode: 'none',
    environment: { pass: [], set: {} },
    sandbox: {
      enforcement: 'none',
      outsideProjectRead: 'deny',
      outsideProjectWrite: false,
      network: 'deny',
    },
  };
}

test('PATH discovery is bounded, scans each directory once, and never turns presence into execution authority', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-tool-discovery-'));
  try {
    await fakeExecutable(directory, 'rg');
    await fakeExecutable(directory, 'git');
    const env = process.platform === 'win32'
      ? { Path: directory, PATHEXT: '.EXE;.CMD' }
      : { PATH: directory };
    let reads = 0;
    const { readdir } = await import('node:fs/promises');
    const discovery = await discoverPathTools({
      env,
      catalog: [
        { command: 'rg', category: 'code-search' },
        { command: 'grep', category: 'code-search' },
        { command: 'git', category: 'vcs' },
      ],
      readDirectory: async (...args) => { reads += 1; return readdir(...args); },
    });
    assert.equal(reads, 1);
    assert.equal(discovery.directoriesScanned, 1);
    assert.equal(discovery.tools.find((entry) => entry.name === 'rg').available, true);
    assert.equal(discovery.tools.find((entry) => entry.name === 'grep').available, false);
    assert.equal(discovery.tools.find((entry) => entry.name === 'rg').probeStatus, 'not-executed');
    assert.equal(discovery.tools.find((entry) => entry.name === 'rg').executableAuthority, false);
    assert.equal(choosePreferredAvailable(discovery, ['grep', 'rg']), 'rg');
    assert.equal(choosePreferredAvailable(discovery, ['missing']), null);
    assert.ok(Number.isFinite(discovery.discoveryElapsedMs));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tool inventory separates discovered presence, local registration, policy, and verified usability without publishing paths', async () => {
  const operationRegistry = { names: () => ['node.syntax-check', 'node.test'] };
  const toolchainRegistry = {
    inspect: async () => [{
      name: 'node', family: 'node', available: true, layer: 'core', version: process.version,
      source: 'current-runtime', executable: '/SECRET/HOST/PATH/node', linker: '/SECRET/HOST/PATH/link',
    }],
  };
  const sandboxStatus = fakeSandbox(false);
  const sandboxProvider = { inspect: () => sandboxStatus };
  const service = new ToolInventoryService({
    operationRegistry,
    toolchainRegistry,
    sandboxProvider,
    profiles: { deterministic: profile(), model: profile() },
    deterministicProfileNames: ['deterministic'],
    modelAdaptersEnabled: false,
    env: process.env,
    discoverPathToolsEnabled: false,
    runtimeIdentity: { version: '0.1.0', commitSha: 'a'.repeat(40) },
  });
  const first = await service.refresh();
  const second = await service.refresh();
  assert.equal(second.digest, first.digest);
  assert.equal(second.generation, first.generation);
  assert.deepEqual(service.reference(), {
    protocol: 'devbridge/tool-inventory-ref-v1',
    digest: first.digest,
    generation: first.generation,
  });
  assert.equal(first.inventory.operations.find((entry) => entry.name === 'node.syntax-check').usable, true);
  assert.equal(first.inventory.operations.find((entry) => entry.name === 'node.test').usable, false);
  assert.equal(first.inventory.adapters.find((entry) => entry.name === 'deterministic').enabled, true);
  assert.equal(first.inventory.adapters.find((entry) => entry.name === 'deterministic').usable, false);
  assert.equal(first.inventory.adapters.find((entry) => entry.name === 'model').enabled, false);
  assert.equal(first.inventory.adapters.find((entry) => entry.name === 'model').usable, false);
  assert.equal(first.inventory.enforcement.verified, false);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /SECRET\/HOST\/PATH/u);
  assert.doesNotMatch(serialized, /"executable"/u);
  assert.doesNotMatch(serialized, /"linker"/u);
});

test('verified enforcement changes the stable inventory digest and enables repository-code operations', async () => {
  const operationRegistry = { names: () => ['node.test'] };
  const toolchainRegistry = { inspect: async () => [] };
  let verified = false;
  const sandboxProvider = { inspect: () => fakeSandbox(verified) };
  const service = new ToolInventoryService({
    operationRegistry,
    toolchainRegistry,
    sandboxProvider,
    profiles: { deterministic: profile() },
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
  assert.equal(second.inventory.adapters[0].enforcement.verified, true);
});

test('unfamiliar PATH tools remain informational and cannot expand the registered operation set', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pp-tool-novel-'));
  try {
    await fakeExecutable(directory, 'novel-tool');
    const env = process.platform === 'win32'
      ? { Path: directory, PATHEXT: '.EXE' }
      : { PATH: directory };
    const discovery = await discoverPathTools({ env, catalog: [{ command: 'novel-tool', category: 'other' }] });
    assert.equal(discovery.tools[0].available, true);
    assert.equal(discovery.tools[0].executableAuthority, false);
    assert.equal(discovery.tools[0].probeStatus, 'not-executed');
    const operations = { names: () => ['node.syntax-check'] };
    assert.deepEqual(operations.names(), ['node.syntax-check']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitHub inventory projection coalesces by digest and never adopts a forged marker comment', async () => {
  const state = new Map();
  const calls = [];
  const stateStore = { get: async (key) => state.get(key), set: async (key, value) => state.set(key, value) };
  const client = {
    request: async (method, requestPath, options = {}) => {
      calls.push({ method, requestPath, options });
      if (method === 'GET') throw new Error('projector must not search/adopt marker comments');
      if (method === 'POST') return { data: { id: 701 } };
      if (method === 'PATCH') return { data: { id: 701 } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const projector = new ToolInventoryProjector({ client, stateStore, queueRepository: 'iteathen/DevBridge' });
  const record = {
    protocol: 'devbridge/tool-inventory-record-v1',
    digest: 'a'.repeat(64),
    generation: 1,
    generatedAt: '2026-08-18T20:00:00Z',
    inventory: { protocol: 'devbridge/tool-inventory-v1', authority: 'local-observation-only' },
  };
  const first = await projector.project({ issueNumber: 31, record });
  const second = await projector.project({ issueNumber: 31, record });
  assert.equal(first.projected, true);
  assert.equal(second.projected, false);
  assert.equal(second.reason, 'unchanged');
  assert.equal(calls.filter((entry) => entry.method === 'POST').length, 1);
  assert.equal(calls.filter((entry) => entry.method === 'GET').length, 0);

  const changed = { ...record, digest: 'b'.repeat(64), generation: 2 };
  await projector.project({ issueNumber: 31, record: changed });
  assert.equal(calls.filter((entry) => entry.method === 'PATCH').length, 1);
});

test('inventory projection refuses secret-bearing content rather than mutating a digest-bound payload', async () => {
  const projector = new ToolInventoryProjector({
    client: { request: async () => { throw new Error('must not publish'); } },
    stateStore: { get: async () => null, set: async () => {} },
    queueRepository: 'iteathen/DevBridge',
    secretValues: ['super-secret-token'],
  });
  const record = {
    protocol: 'devbridge/tool-inventory-record-v1',
    digest: 'a'.repeat(64),
    generation: 1,
    inventory: { protocol: 'devbridge/tool-inventory-v1', accidental: 'super-secret-token' },
  };
  await assert.rejects(projector.project({ issueNumber: 31, record }), /refusing to publish/u);
});

test('ordinary status context references the current inventory digest without embedding the inventory', async () => {
  const calls = [];
  const state = new Map();
  const reporter = new IssueStatusReporter({
    client: {
      request: async (method, requestPath, options) => {
        calls.push({ method, requestPath, options });
        return { data: { id: 99 } };
      },
    },
    stateStore: { get: async (key) => state.get(key), set: async (key, value) => state.set(key, value) },
    queueRepository: 'iteathen/DevBridge',
    inventoryRefProvider: () => ({ protocol: 'devbridge/tool-inventory-ref-v1', digest: 'c'.repeat(64), generation: 7 }),
  });
  await reporter.publish({
    issueNumber: 31,
    runId: 'pp-31-abcdef',
    revision: 'd'.repeat(64),
    stage: 'RUNNING',
    summary: 'test',
    capsule: { protocol: 'devbridge/context-v1', sequence: 1 },
    force: true,
  });
  const body = calls[0].options.body.body;
  assert.match(body, /devbridge\/tool-inventory-ref-v1/u);
  assert.match(body, new RegExp('c{64}', 'u'));
  assert.doesNotMatch(body, /discoveredTools/u);
});
