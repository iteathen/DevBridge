import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExactActionRouter } from '../src/runtime/exact-action-router.js';
import { createExactDirectory, EXACT_DIRECTORY_PROTOCOL } from '../src/runtime/exact-directory.js';

function action() {
  return createExactDirectory({
    platform: process.platform,
    ...(process.platform === 'win32' ? { inspectReparse: async (_location, info) => info.isSymbolicLink() } : {}),
  });
}

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'devbridge-exact-directory-'));
  const location = path.join(parent, 'selected');
  await mkdir(location);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, location };
}

test('exact directory owns one identity and removes it only while empty', async (t) => {
  const selected = await fixture(t);
  const api = action();
  const manifest = await api.plan({ identity: 'directory.one', location: selected.location });
  assert.equal(manifest.protocol, EXACT_DIRECTORY_PROTOCOL);
  assert.equal(manifest.bytes, 0);
  assert.equal((await api.observe(manifest)).state, 'present');
  await writeFile(path.join(selected.location, 'foreign'), 'preserve');
  await assert.rejects(() => api.remove(manifest), /not empty/u);
  await rm(path.join(selected.location, 'foreign'));
  assert.deepEqual(await api.remove(manifest), { identity: 'directory.one', removed: true, absent: false });
  assert.equal((await api.observe(manifest)).state, 'absent');
  assert.deepEqual(await api.remove(manifest), { identity: 'directory.one', removed: false, absent: true });
});

test('replacement, manifest drift, and indirection are ambiguous or rejected', async (t) => {
  const selected = await fixture(t);
  const api = action();
  const manifest = await api.plan({ identity: 'directory.two', location: selected.location });
  await rmdir(selected.location);
  await mkdir(selected.location);
  assert.equal((await api.observe(manifest)).state, 'ambiguous');
  await assert.rejects(() => api.remove(manifest), /ambiguous/u);
  await assert.rejects(() => api.observe({ ...manifest, digest: '0'.repeat(64) }), /digest changed/u);

  const target = path.join(selected.parent, 'target');
  const linked = path.join(selected.parent, 'linked');
  await mkdir(target);
  try { await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') { t.skip('symlink creation is unavailable'); return; }
    throw error;
  }
  await assert.rejects(() => api.plan({ identity: 'directory.linked', location: linked }), /real directory|indirection/u);
});

test('exact action router selects only a locally registered protocol', async () => {
  const calls = [];
  const router = createExactActionRouter({ actions: [{
    protocol: 'test/action-v1',
    action: {
      async observe(value) { calls.push(['observe', value]); return { identity: value.identity, state: 'present', retryable: true }; },
      async remove(value) { calls.push(['remove', value]); return { identity: value.identity, removed: true, absent: false }; },
    },
  }] });
  const value = { protocol: 'test/action-v1', identity: 'selected' };
  assert.equal((await router.observe(value)).state, 'present');
  assert.equal((await router.remove(value)).removed, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['observe', 'remove']);
  assert.throws(() => router.observe({ protocol: 'test/other-v1', identity: 'selected' }), /unavailable/u);
  assert.throws(() => createExactActionRouter({ actions: [
    { protocol: 'test/action-v1', action: { observe() {}, remove() {} } },
    { protocol: 'test/action-v1', action: { observe() {}, remove() {} } },
  ] }), /duplicate/u);
});
