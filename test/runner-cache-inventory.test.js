import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContentAddressedRunnerProvider } from '../src/entry/content-addressed-runner-provider.mjs';
import { normalizeRunnerSubject, RUNNER_SUBJECT_PROTOCOL } from '../src/entry/permanent-entry.mjs';
import { createRunnerCacheComposition } from '../src/entry/runner-cache-composition.mjs';
import { createRunnerCacheInventory, RUNNER_CACHE_INVENTORY_IDENTITY } from '../src/entry/runner-cache-inventory.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'devbridge-cache-inventory-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cacheRoot = path.join(home, 'entry', 'cache');
  const stateRoot = path.join(home, 'entry', 'state');
  return { home, cacheRoot, stateRoot, cache: createRunnerCacheComposition({ cacheRoot, stateRoot }) };
}

function subject(bytes) {
  return Object.freeze({
    protocol: RUNNER_SUBJECT_PROTOCOL,
    head: 'a'.repeat(40),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    minimumEntryProtocol: 1,
    channel: 'stable',
    releaseId: 'release-one',
  });
}

test('an absent cache is exact complete absence without creating payload or authority', async (t) => {
  const selected = await fixture(t);
  const inventory = createRunnerCacheInventory({ home: selected.home });
  const fragment = await inventory.snapshot();
  assert.equal(inventory.identity, RUNNER_CACHE_INVENTORY_IDENTITY);
  assert.deepEqual(fragment.coverage, ['application']);
  assert.deepEqual(fragment.items, []);
  assert.equal(fragment.mutationActive, false);
});

test('content materialization projects receipt-owned leaves and structural dependencies without private paths', async (t) => {
  const selected = await fixture(t);
  const bytes = Buffer.from('runner-inventory');
  const exact = subject(bytes);
  const provider = new ContentAddressedRunnerProvider({
    source: { async read() { return bytes; } },
    normalizeSubject: normalizeRunnerSubject,
    ...selected.cache,
    launch() { return 0; },
  });
  await provider.prepare(exact);

  const fragment = await createRunnerCacheInventory({ home: selected.home }).snapshot();
  assert.deepEqual(fragment.coverage, ['application']);
  assert.deepEqual(fragment.items.map((item) => item.identity), [
    'cache.directory.objects',
    'cache.directory.root',
    `cache.object.${exact.sha256}`,
  ]);
  assert.deepEqual(fragment.items.find((item) => item.identity === 'cache.directory.objects').after, [`cache.object.${exact.sha256}`]);
  assert.deepEqual(fragment.items.find((item) => item.identity === 'cache.directory.root').after, ['cache.directory.objects']);
  const encoded = JSON.stringify(fragment);
  assert.equal(encoded.includes(selected.home), false);
  assert.equal(encoded.includes('exact-artifact-set'), false);
  assert.equal(encoded.includes('exact-directory'), false);
});

test('unknown cache residue withholds coverage and remains untouched', async (t) => {
  const selected = await fixture(t);
  const bytes = Buffer.from('runner-residue');
  const exact = subject(bytes);
  await new ContentAddressedRunnerProvider({
    source: { async read() { return bytes; } },
    normalizeSubject: normalizeRunnerSubject,
    ...selected.cache,
    launch() { return 0; },
  }).prepare(exact);
  const foreign = path.join(selected.cacheRoot, 'foreign');
  await writeFile(foreign, 'preserve');
  const fragment = await createRunnerCacheInventory({ home: selected.home }).snapshot();
  assert.deepEqual(fragment.coverage, []);
  assert.equal(fragment.items.length, 3);
  assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(foreign, 'utf8')), 'preserve');
});

test('active cache preparation is observable and withholds binding readiness', async (t) => {
  const selected = await fixture(t);
  await selected.cache.ownership.withActivity(async () => {
    const fragment = await createRunnerCacheInventory({ home: selected.home }).snapshot();
    assert.equal(fragment.mutationActive, true);
  });
});
