import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { assertSafeToolInventoryProjection, buildToolInventory, toolInventoryDigest } from '../src/runtime/tool-inventory.js';

function fixtures({ verified = false } = {}) {
  const sandboxManager = {
    inspect: async () => ({
      provider: 'bubblewrap', configured: true, available: true, verified,
      reason: verified ? null : 'boundary-probe-failed', boundaries: verified ? { networkDenied: true } : null,
      checkedAt: new Date().toISOString(),
    })
  };
  const operationRegistry = {
    describe: () => [
      { name: 'node.syntax-check', layer: 'core', executionClass: 'static-safe', requiredEnforcement: 'none' },
      { name: 'node.test', layer: 'core', executionClass: 'repository-code-executing', requiredEnforcement: 'verified-os-sandbox' },
    ]
  };
  const toolchainRegistry = {
    inspect: async () => [
      { name: 'node', family: 'node', available: true, health: 'healthy', version: `v1 from ${path.join(path.sep, 'home', 'runner', 'secret')}`, source: 'current-runtime', probedAt: new Date().toISOString() }
    ]
  };
  return { sandboxManager, operationRegistry, toolchainRegistry };
}

function discovered() {
  return {
    protocol: 'patch-poller/tool-registry-v1',
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    elapsedMs: 3.2,
    budgetMs: 45,
    complete: true,
    entries: [{
      name: 'rg', category: 'search', available: true,
      executable: path.resolve('must-never-publish'),
      identity: { size: 123, mtimeMs: 123 },
      source: 'PATH-scan', version: 'ripgrep 99.0', health: 'healthy', lastProbeAt: new Date().toISOString()
    }]
  };
}

test('inventory separates declared sandbox policy from verified enforcement and never publishes local paths', async () => {
  const runtimeRoot = path.dirname(path.dirname(process.execPath));
  const inventory = await buildToolInventory({
    ...fixtures({ verified: false }),
    tools: {
      agent: {
        executable: process.execPath,
        args: [],
        inputMode: 'stdin-json',
        sandbox: {
          enforcement: 'os',
          outsideProjectRead: 'allowlist',
          readOnlyRoots: [runtimeRoot],
          outsideProjectWrite: false,
          network: 'deny'
        }
      }
    },
    deterministicProfileNames: [],
    modelAdaptersEnabled: true,
    allowUncontainedTools: false,
    discoveredRegistry: discovered(),
    env: process.env,
  });

  assert.equal(inventory.protocol, 'patch-poller/tool-inventory-v1');
  assert.equal(inventory.sandbox.verified, false);
  const adapter = inventory.adapters.find((entry) => entry.name === 'agent');
  assert.equal(adapter.declaredPolicy.enforcement, 'os');
  assert.equal(adapter.declaredPolicy.readOnlyRootCount, 1);
  assert.equal(adapter.verifiedEnforcement.verified, false);
  assert.equal(adapter.eligibleForAutomaticSelection, false);
  assert.equal(adapter.usable, false);
  assert.equal(inventory.toolchains[0].version, null);
  assert.equal(inventory.discovered.entries[0].executable, undefined);
  assert.equal(inventory.discovered.entries[0].identity, undefined);
  assert.doesNotMatch(JSON.stringify(inventory), /must-never-publish|home[\\/]runner[\\/]secret/u);
  assert.equal(toolInventoryDigest(inventory), inventory.digest);
  assert.equal(assertSafeToolInventoryProjection(inventory), true);
});

test('inventory digest is stable across volatile probe timestamps and elapsed timing', async () => {
  const options = {
    ...fixtures({ verified: true }),
    tools: {},
    deterministicProfileNames: [],
    modelAdaptersEnabled: false,
    allowUncontainedTools: false,
    discoveredRegistry: discovered(),
    env: process.env,
  };
  const first = await buildToolInventory(options);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await buildToolInventory({ ...options, discoveredRegistry: discovered() });
  assert.equal(first.digest, second.digest);
  assert.equal(first.generation, second.generation);
});
