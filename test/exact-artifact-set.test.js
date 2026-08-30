import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExactArtifactSet, EXACT_ARTIFACT_SET_PROTOCOL } from '../src/runtime/exact-artifact-set.js';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'devbridge-artifacts-'));
  const root = path.join(parent, 'owned');
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'first.bin'), 'first');
  await writeFile(path.join(root, 'nested', 'second.bin'), 'second');
  const api = createExactArtifactSet({ platform: process.platform, ...(process.platform === 'win32' ? { inspectReparse: async (_location, info) => info.isSymbolicLink() } : {}) });
  return { parent, root, api };
}

function request(root) {
  return {
    identity: 'set-1111111111111111',
    root,
    files: [
      { relative: 'first.bin', bytes: 5, sha256: sha256('first') },
      { relative: 'nested/second.bin', bytes: 6, sha256: sha256('second') },
    ],
    directories: ['nested'],
  };
}

test('exact artifact set plans and removes only an enumerated real tree', async () => {
  const state = await fixture();
  try {
    const manifest = await state.api.plan(request(state.root));
    assert.equal(manifest.protocol, EXACT_ARTIFACT_SET_PROTOCOL);
    assert.equal(manifest.bytes, 11);
    assert.equal((await state.api.observe(manifest)).state, 'present');
    const result = await state.api.remove(manifest);
    assert.equal(result.removed, true);
    assert.equal((await state.api.observe(manifest)).state, 'absent');
    const again = await state.api.remove(manifest);
    assert.equal(again.absent, true);
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});

test('unexpected content blocks planning and post-plan injection blocks removal', async () => {
  const state = await fixture();
  try {
    await writeFile(path.join(state.root, 'foreign.bin'), 'foreign');
    await assert.rejects(() => state.api.plan(request(state.root)), /unexpected or missing/u);
    await unlink(path.join(state.root, 'foreign.bin'));
    const manifest = await state.api.plan(request(state.root));
    await writeFile(path.join(state.root, 'foreign.bin'), 'foreign');
    assert.equal((await state.api.observe(manifest)).state, 'ambiguous');
    await assert.rejects(() => state.api.remove(manifest), /ambiguous/u);
    assert.equal(await readFile(path.join(state.root, 'foreign.bin'), 'utf8'), 'foreign');
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});

test('replacement, hard-link, and digest drift fail closed', async () => {
  const state = await fixture();
  try {
    const manifest = await state.api.plan(request(state.root));
    await unlink(path.join(state.root, 'first.bin'));
    await writeFile(path.join(state.root, 'first.bin'), 'first');
    assert.equal((await state.api.observe(manifest)).state, 'ambiguous');
  } finally { await rm(state.parent, { recursive: true, force: true }); }

  const linked = await fixture();
  try {
    await link(path.join(linked.root, 'first.bin'), path.join(linked.parent, 'second-link'));
    await assert.rejects(() => linked.api.plan(request(linked.root)), /shape is unsafe/u);
  } finally { await rm(linked.parent, { recursive: true, force: true }); }

  const changed = await fixture();
  try {
    const manifest = await changed.api.plan(request(changed.root));
    await writeFile(path.join(changed.root, 'first.bin'), 'other');
    assert.equal((await changed.api.observe(manifest)).state, 'ambiguous');
  } finally { await rm(changed.parent, { recursive: true, force: true }); }
});

test('filesystem indirection and explicit reparse evidence cannot enter a plan', async (t) => {
  const state = await fixture();
  try {
    const target = path.join(state.parent, 'outside');
    await mkdir(target);
    await writeFile(path.join(target, 'second.bin'), 'second');
    await rm(path.join(state.root, 'nested'), { recursive: true, force: true });
    try { await symlink(target, path.join(state.root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (process.platform === 'win32' && error?.code === 'EPERM') { t.skip('symlink creation is unavailable'); return; } throw error; }
    await assert.rejects(() => state.api.plan(request(state.root)), /real directory|shape is unsafe/u);
  } finally { await rm(state.parent, { recursive: true, force: true }); }

  const flagged = await fixture();
  try {
    const api = createExactArtifactSet({
      platform: 'win32',
      inspectReparse: async (location, info) => info.isSymbolicLink() || location.endsWith('first.bin'),
    });
    await assert.rejects(() => api.plan(request(flagged.root)), /shape is unsafe/u);
  } finally { await rm(flagged.parent, { recursive: true, force: true }); }
});

test('partial deletion is restart-reconcilable from the immutable manifest', async () => {
  const state = await fixture();
  try {
    const manifest = await state.api.plan(request(state.root));
    await unlink(path.join(state.root, 'nested', 'second.bin'));
    assert.equal((await state.api.observe(manifest)).state, 'present');
    const result = await state.api.remove(manifest);
    assert.equal(result.removed, true);
    assert.equal((await state.api.observe(manifest)).state, 'absent');
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});

test('bounded discovery inventories one already-authorized tree without widening later cleanup', async () => {
  const state = await fixture();
  try {
    const manifest = await state.api.discover({ identity: 'set-discovered-1111', root: state.root });
    assert.equal(manifest.entries.length, 3);
    await writeFile(path.join(state.root, 'later.bin'), 'later');
    assert.equal((await state.api.observe(manifest)).state, 'ambiguous');
    await assert.rejects(() => state.api.remove(manifest), /ambiguous/u);
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});

test('a non-exclusive set removes only exact entries below a retained shared root', async () => {
  const state = await fixture();
  try {
    const manifest = await state.api.plan({
      identity: 'set-shared-11111111',
      root: state.root,
      files: [{ relative: 'first.bin', bytes: 5, sha256: sha256('first') }],
      directories: [],
      exclusive: false,
      removeRoot: false,
    });
    const result = await state.api.remove(manifest);
    assert.equal(result.removed, true);
    assert.equal(await readFile(path.join(state.root, 'nested', 'second.bin'), 'utf8'), 'second');
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});

test('an empty exact root remains present until its directory is removed', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'devbridge-empty-artifacts-'));
  const root = path.join(parent, 'owned');
  await mkdir(root);
  const api = createExactArtifactSet({ platform: process.platform, ...(process.platform === 'win32' ? { inspectReparse: async (_location, info) => info.isSymbolicLink() } : {}) });
  try {
    const manifest = await api.plan({ identity: 'set-empty-11111111', root, files: [], directories: [], exclusive: true, removeRoot: true });
    assert.equal((await api.observe(manifest)).state, 'present');
    await api.remove(manifest);
    assert.equal((await api.observe(manifest)).state, 'absent');
  } finally { await rm(parent, { recursive: true, force: true }); }
});
