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
import { REPOSITORY_EXECUTION_STATUS_PROTOCOL } from '../src/runtime/repository-execution.js';

async function fakeExecutable(directory, name) {
  const actual = process.platform === 'win32' ? `${name}.EXE` : name;
  await writeFile(path.join(directory, actual), '', { mode: 0o755 });
}
function status(ready = false) {
  return ready
    ? { protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'fixture', reason: null }
    : { protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'unavailable', ready: false, identity: null, reason: 'stage-1-no-provider' };
}
function execution(ready = false) { return { inspect: () => status(ready), async execute() { throw new Error('not used'); } }; }
function profile() {
  return { executable: process.execPath, args: [], inputMode: 'none', environment: { pass: [], set: {} }, sandbox: { enforcement: 'none', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' } };
}

test('PATH discovery remains presence-only and never creates execution authority', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-tool-discovery-'));
  try {
    await fakeExecutable(directory, 'rg');
    const env = process.platform === 'win32' ? { Path: directory, PATHEXT: '.EXE;.CMD' } : { PATH: directory };
    const discovery = await discoverPathTools({ env, catalog: [{ command: 'rg', category: 'code-search' }, { command: 'grep', category: 'code-search' }] });
    assert.equal(discovery.tools.find((entry) => entry.name === 'rg').available, true);
    assert.equal(discovery.tools.find((entry) => entry.name === 'rg').probeStatus, 'not-executed');
    assert.equal(discovery.tools.find((entry) => entry.name === 'rg').executableAuthority, false);
    assert.equal(choosePreferredAvailable(discovery, ['grep', 'rg']), 'rg');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('inventory reports no-provider separately and does not use host profile executables as repository readiness', async () => {
  const service = new ToolInventoryService({
    operationRegistry: { names: () => ['node.syntax-check', 'node.test'] },
    toolchainRegistry: { inspect: async () => [{ name: 'node', family: 'node', available: true, layer: 'core', version: process.version, source: 'current-runtime', executable: '/SECRET/HOST/PATH/node' }] },
    repositoryExecution: execution(false),
    profiles: { deterministic: profile(), model: profile() },
    deterministicProfileNames: ['deterministic'], modelAdaptersEnabled: false,
    discoverPathToolsEnabled: false,
    runtimeIdentity: { version: '0.1.0', commitSha: 'a'.repeat(40) },
  });
  const record = await service.refresh();
  assert.equal(record.inventory.repositoryExecution.ready, false);
  assert.equal(record.inventory.operations.find((entry) => entry.name === 'node.syntax-check').usable, true);
  assert.equal(record.inventory.operations.find((entry) => entry.name === 'node.test').usable, false);
  assert.equal(record.inventory.adapters.find((entry) => entry.name === 'deterministic').available, false);
  assert.equal(record.inventory.adapters.find((entry) => entry.name === 'deterministic').errorClass, 'repository-execution-unavailable');
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /SECRET\/HOST\/PATH/u);
  assert.doesNotMatch(serialized, /"executable"/u);
  assert.doesNotMatch(serialized, /bubblewrap/iu);
});

test('ready fake changes inventory digest and enables repository-class operations without provider-specific fields', async () => {
  let ready = false;
  const repositoryExecution = { inspect: () => status(ready), async execute() { throw new Error('not used'); } };
  const service = new ToolInventoryService({
    operationRegistry: { names: () => ['node.test'] }, toolchainRegistry: { inspect: async () => [] }, repositoryExecution,
    profiles: { deterministic: profile() }, deterministicProfileNames: ['deterministic'], discoverPathToolsEnabled: false,
  });
  const first = await service.refresh();
  ready = true;
  const second = await service.refresh();
  assert.notEqual(second.digest, first.digest);
  assert.equal(second.inventory.operations[0].usable, true);
  assert.equal(second.inventory.adapters[0].usable, true);
  assert.deepEqual(Object.keys(second.inventory.repositoryExecution).sort(), ['identity', 'ready', 'reason', 'state']);
});

test('GitHub inventory projection coalesces by digest and never adopts a forged marker comment', async () => {
  const stateStoreMap = new Map(); const calls = [];
  const projector = new ToolInventoryProjector({
    client: { request: async (method, requestPath, options = {}) => { calls.push({ method, requestPath, options }); if (method === 'GET') throw new Error('must not search'); return { data: { id: 701 } }; } },
    stateStore: { get: async (key) => stateStoreMap.get(key), set: async (key, value) => stateStoreMap.set(key, value) }, queueRepository: 'iteathen/DevBridge',
  });
  const record = { protocol: 'devbridge/tool-inventory-record-v1', digest: 'a'.repeat(64), generation: 1, generatedAt: '2026-08-18T20:00:00Z', inventory: { protocol: 'devbridge/tool-inventory-v1', authority: 'local-observation-only' } };
  const first = await projector.project({ issueNumber: 31, record }); const second = await projector.project({ issueNumber: 31, record });
  assert.equal(first.projected, true); assert.equal(second.projected, false); assert.equal(calls.filter((entry) => entry.method === 'GET').length, 0);
});

test('ordinary status context references inventory digest without embedding inventory', async () => {
  const calls = []; const stateMap = new Map();
  const reporter = new IssueStatusReporter({
    client: { request: async (method, requestPath, options) => { calls.push({ method, requestPath, options }); return { data: { id: 99 } }; } },
    stateStore: { get: async (key) => stateMap.get(key), set: async (key, value) => stateMap.set(key, value) }, queueRepository: 'iteathen/DevBridge',
    inventoryRefProvider: () => ({ protocol: 'devbridge/tool-inventory-ref-v1', digest: 'c'.repeat(64), generation: 7 }),
  });
  await reporter.publish({ issueNumber: 31, runId: 'pp-31-abcdef', revision: 'd'.repeat(64), stage: 'RUNNING', summary: 'test', capsule: { protocol: 'devbridge/context-v1', sequence: 1 }, force: true });
  const body = calls[0].options.body.body;
  assert.match(body, /devbridge\/tool-inventory-ref-v1/u); assert.doesNotMatch(body, /discoveredTools/u);
});
