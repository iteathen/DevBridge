import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunnerCacheOwnership, runnerCacheOwnershipPaths } from '../src/entry/runner-cache-ownership.mjs';
import { createExactDirectory } from '../src/runtime/exact-directory.js';

function directoryAction() {
  return createExactDirectory({
    platform: process.platform,
    ...(process.platform === 'win32' ? { inspectReparse: async (_location, info) => info.isSymbolicLink() } : {}),
  });
}

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'devbridge-cache-ownership-'));
  const stateRoot = path.join(home, 'entry', 'state');
  const cacheRoot = path.join(home, 'entry', 'cache');
  t.after(() => rm(home, { recursive: true, force: true }));
  const ownership = createRunnerCacheOwnership({ stateRoot, directories: directoryAction() });
  return { home, stateRoot, cacheRoot, ownership };
}

test('runner-cache ownership reserves and completes exact directories under one observable activity', async (t) => {
  const selected = await fixture(t);
  assert.deepEqual(selected.ownership.observe(), { active: false });
  let first;
  await selected.ownership.withActivity(async (session) => {
    assert.deepEqual(selected.ownership.observe(), { active: true });
    first = await session.directory({ identity: 'cache.directory.root', location: selected.cacheRoot });
    assert.equal(first.provenance, 'created');
    assert.equal(first.value.phase, 'complete');
  });
  assert.deepEqual(selected.ownership.observe(), { active: false });

  await selected.ownership.withActivity(async (session) => {
    const again = await session.directory({ identity: 'cache.directory.root', location: selected.cacheRoot });
    assert.deepEqual(again, first);
  });
});

test('runner-cache ownership adopts only an exact existing directory and keeps state outside payload', async (t) => {
  const selected = await fixture(t);
  await mkdir(selected.cacheRoot, { recursive: true });
  await selected.ownership.withActivity(async (session) => {
    const adopted = await session.directory({ identity: 'cache.directory.root', location: selected.cacheRoot });
    assert.equal(adopted.provenance, 'adopted');
  });
  const paths = runnerCacheOwnershipPaths(selected.stateRoot);
  assert.equal(paths.receipts.startsWith(selected.stateRoot), true);
  assert.equal(paths.receipts.startsWith(selected.cacheRoot), false);
});
