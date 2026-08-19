import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { ToolInventoryService } from '../src/runtime/tool-inventory.js';

function profile() {
  return {
    executable: process.execPath,
    args: [],
    inputMode: 'none',
    environment: { pass: [], set: {} },
    sandbox: { enforcement: 'none', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' },
  };
}

test('path-shaped local adapter names and raw toolchain errors never enter remote inventory', async () => {
  const service = new ToolInventoryService({
    operationRegistry: { names: () => [] },
    toolchainRegistry: {
      inspect: async () => [{
        name: 'fixture',
        available: false,
        layer: 'core',
        error: '/SECRET/HOST/compiler disappeared',
      }],
    },
    sandboxProvider: { inspect: () => ({ provider: 'none', verified: false, verification: 'unavailable' }) },
    profiles: { '/SECRET/HOST/adapter': profile() },
    modelAdaptersEnabled: true,
    discoverPathToolsEnabled: false,
  });
  const record = await service.refresh();
  assert.equal(record.inventory.adapters[0].name, null);
  assert.equal(record.inventory.toolchains[0].errorClass, 'discovery-failed');
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /SECRET\/HOST/u);
  assert.doesNotMatch(serialized, /compiler disappeared/u);
});
