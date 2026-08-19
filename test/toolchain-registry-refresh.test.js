import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToolchainRegistry } from '../src/runtime/toolchain-registry.js';

test('explicit toolchain refresh discards cached availability before probing again', async () => {
  let available = true;
  let probes = 0;
  const registry = new LocalToolchainRegistry().register('fixture', async () => {
    probes += 1;
    if (!available) throw new Error('/private/host/tool disappeared');
    return { executable: '/private/host/tool', family: 'fixture', version: '1.0.0', source: 'local-discovery' };
  });

  const first = await registry.resolve('fixture');
  assert.equal(first.family, 'fixture');
  assert.equal(probes, 1);

  available = false;
  const cached = await registry.resolve('fixture');
  assert.equal(cached.family, 'fixture');
  assert.equal(probes, 1);

  await assert.rejects(registry.resolve('fixture', { refresh: true }), /disappeared/u);
  assert.equal(probes, 2);

  const inventoryProbe = await registry.inspect();
  assert.equal(inventoryProbe[0].available, false);
  assert.equal(probes, 3);
});
