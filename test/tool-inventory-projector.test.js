import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolInventoryProjector } from '../src/github/tool-inventory-projector.js';
import { toolInventoryDigest } from '../src/runtime/tool-inventory.js';

function inventory(version = '1.0.0') {
  const value = {
    protocol: 'patch-poller/tool-inventory-v1',
    generatedAt: '2026-08-18T12:00:00Z',
    runtime: { family: 'patch-poller', version, commit: null },
    host: { platform: 'linux', arch: 'x64' },
    sandbox: { configuredProvider: 'bubblewrap', configured: true, available: true, verified: true, reason: null, boundaries: { networkDenied: true } },
    operations: [],
    toolchains: [],
    adapters: [],
    discovered: null,
  };
  value.digest = toolInventoryDigest(value);
  value.generation = value.digest.slice(0, 16);
  return value;
}

class MemoryStore {
  map = new Map();
  async get(key) { return this.map.get(key) ?? null; }
  async set(key, value) { this.map.set(key, structuredClone(value)); }
}

test('projects one inventory comment then suppresses unchanged digest mutations', async () => {
  const calls = [];
  const client = {
    request: async (method, requestPath, options = {}) => {
      calls.push({ method, requestPath, options });
      if (method === 'GET') return { data: [], headers: {} };
      if (method === 'POST') return { data: { id: 77 }, headers: {} };
      throw new Error(`unexpected ${method}`);
    }
  };
  const projector = new ToolInventoryProjector({
    client,
    stateStore: new MemoryStore(),
    queueRepository: 'iteathen/PATCH-POLLER',
  });
  const value = inventory();
  const first = await projector.project({ issueNumber: 31, inventory: value });
  const second = await projector.project({ issueNumber: 31, inventory: value });

  assert.equal(first.projected, true);
  assert.equal(first.commentId, 77);
  assert.equal(second.projected, false);
  assert.equal(second.reason, 'unchanged');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
});

test('refuses to publish if secret redaction would change the inventory authority payload', async () => {
  const projector = new ToolInventoryProjector({
    client: { request: async () => { throw new Error('GitHub mutation must not occur'); } },
    stateStore: new MemoryStore(),
    queueRepository: 'iteathen/PATCH-POLLER',
    secretValues: ['super-secret-version'],
  });
  await assert.rejects(
    projector.project({ issueNumber: 31, inventory: inventory('super-secret-version') }),
    /required secret redaction/u,
  );
});
