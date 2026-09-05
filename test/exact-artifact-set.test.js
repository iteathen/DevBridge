import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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

test('file revalidation returns new evidence without changing old exact observation authority', async () => {
  const state = await fixture();
  try {
    const before = await state.api.plan(request(state.root));
    const saved = structuredClone(before);
    const replacement = path.join(state.parent, 'replacement');
    await writeFile(replacement, 'first');
    await rename(replacement, path.join(state.root, 'first.bin'));
    assert.equal((await state.api.observe(before)).state, 'ambiguous');
    const after = await state.api.revalidateFiles(before);
    assert.notEqual(after.digest, before.digest);
    assert.deepEqual(after.rootIdentity, before.rootIdentity);
    assert.deepEqual(before, saved);
    assert.equal((await state.api.observe(before)).state, 'ambiguous');
    assert.equal((await state.api.observe(after)).state, 'present');
    assert.deepEqual(await state.api.revalidateFiles(after), after);
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});

test('file revalidation rejects changed content, missing/extra files, links and directory replacement', async () => {
  for (const change of ['content', 'missing', 'extra', 'link', 'directory', 'root']) {
    const state = await fixture();
    try {
      const before = await state.api.plan(request(state.root));
      if (change === 'content') await writeFile(path.join(state.root, 'first.bin'), 'other');
      if (change === 'missing') await unlink(path.join(state.root, 'first.bin'));
      if (change === 'extra') await writeFile(path.join(state.root, 'extra'), 'foreign');
      if (change === 'link') await link(path.join(state.root, 'first.bin'), path.join(state.parent, 'alias'));
      if (change === 'directory') {
        await rename(path.join(state.root, 'nested'), path.join(state.parent, 'old-directory'));
        await mkdir(path.join(state.root, 'nested'));
        await writeFile(path.join(state.root, 'nested', 'second.bin'), 'second');
      }
      if (change === 'root') {
        await rename(state.root, path.join(state.parent, 'old-root'));
        await mkdir(path.join(state.root, 'nested'), { recursive: true });
        await writeFile(path.join(state.root, 'first.bin'), 'first');
        await writeFile(path.join(state.root, 'nested', 'second.bin'), 'second');
      }
      await assert.rejects(() => state.api.revalidateFiles(before), undefined, change);
      assert.equal(await readFile(path.join(state.root, 'nested', 'second.bin'), 'utf8'), 'second');
    } finally { await rm(state.parent, { recursive: true, force: true }); }
  }
});

test('file revalidation requires complete exclusive digest authority and stable repeated observations', async () => {
  const state = await fixture();
  try {
    for (const change of ['digest', 'bytes', 'exclusive']) {
      const input = request(state.root);
      if (change === 'digest') delete input.files[0].sha256;
      if (change === 'bytes') delete input.files[0].bytes;
      if (change === 'exclusive') input.exclusive = false;
      const incomplete = await state.api.plan(input);
      await assert.rejects(() => state.api.revalidateFiles(incomplete), /complete content evidence/u);
    }
    const before = await state.api.plan(request(state.root));
    const originalPlan = state.api.plan.bind(state.api);
    let planned = false;
    state.api.plan = async (input) => {
      const result = await originalPlan(input);
      if (!planned) {
        planned = true;
        await writeFile(path.join(state.parent, 'replacement'), 'first');
        await rename(path.join(state.parent, 'replacement'), path.join(state.root, 'first.bin'));
      }
      return result;
    };
    await assert.rejects(() => state.api.revalidateFiles(before), /changed during observation/u);
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});

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

test('planning validates caller-supplied content digests before creating authority', async () => {
  const state = await fixture();
  try {
    const changed = request(state.root);
    changed.files[0].sha256 = sha256('wrong');
    await assert.rejects(() => state.api.plan(changed), /digest does not match authority/u);
  } finally { await rm(state.parent, { recursive: true, force: true }); }
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
    await assert.rejects(() => state.api.plan(request(state.root)), /real directory|shape is unsafe|reparse point/u);
  } finally { await rm(state.parent, { recursive: true, force: true }); }

  const flagged = await fixture();
  try {
    const api = createExactArtifactSet({
      platform: process.platform,
      inspectReparse: async (location, info) => info.isSymbolicLink() || location.endsWith('first.bin'),
    });
    await assert.rejects(() => api.plan(request(flagged.root)), /shape is unsafe|reparse point/u);
  } finally { await rm(flagged.parent, { recursive: true, force: true }); }
});

test('Windows artifact planning and observation batch reparse checks without per-entry processes', { skip: process.platform !== 'win32' }, async () => {
  const state = await fixture();
  let singleCalls = 0;
  const batches = [];
  try {
    const api = createExactArtifactSet({
      platform: 'win32',
      inspectReparse: async () => { singleCalls += 1; return false; },
      inspectReparseBatch: async (locations) => {
        batches.push([...locations]);
        return locations.map(() => ({ exists: true, reparse: false }));
      },
    });
    const manifest = await api.plan(request(state.root));
    assert.equal((await api.observe(manifest)).state, 'present');
    assert.equal(singleCalls, 0);
    assert.equal(batches.length, 4);
    assert.equal(batches.every((batch) => batch.length === 4), true);
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});

test('Windows artifact planning splits reparse observations at the fixed batch bound', { skip: process.platform !== 'win32' }, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'devbridge-artifact-batches-'));
  const root = path.join(parent, 'owned');
  const batches = [];
  try {
    await mkdir(root);
    const files = Array.from({ length: 513 }, (_, index) => ({ relative: `artifact-${String(index).padStart(3, '0')}.bin` }));
    await Promise.all(files.map((entry) => writeFile(path.join(root, entry.relative), '')));
    const api = createExactArtifactSet({
      platform: 'win32',
      inspectReparse: async () => { throw new Error('single-entry reparse observation is forbidden'); },
      inspectReparseBatch: async (locations) => {
        batches.push([...locations]);
        return locations.map(() => ({ exists: true, reparse: false }));
      },
    });
    await api.plan({ identity: 'set-batched-11111111', root, files, directories: [] });
    assert.deepEqual(batches.map((batch) => batch.length), [512, 2, 512, 2]);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('Windows batch reparse evidence still fails closed', { skip: process.platform !== 'win32' }, async () => {
  const state = await fixture();
  let calls = 0;
  try {
    const api = createExactArtifactSet({
      platform: 'win32',
      inspectReparse: async () => false,
      inspectReparseBatch: async (locations) => locations.map((location) => ({
        exists: true,
        reparse: ++calls === 2 && location.endsWith('first.bin'),
      })),
    });
    await assert.rejects(() => api.plan(request(state.root)), /reparse point/u);
  } finally { await rm(state.parent, { recursive: true, force: true }); }
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
    assert.deepEqual(
      manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.expectedSha256).sort(),
      [sha256('first'), sha256('second')].sort(),
    );
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

test('path observations remain authoritative when handle timestamp precision differs', async () => {
  const state = await fixture();
  try {
    const api = createExactArtifactSet({
      platform: process.platform,
      ...(process.platform === 'win32' ? { inspectReparse: async (_location, info) => info.isSymbolicLink() } : {}),
      openFile: async (location, flags) => {
        const handle = await open(location, flags);
        return {
          read: handle.read.bind(handle),
          close: handle.close.bind(handle),
          async stat(options) {
            const info = await handle.stat(options);
            info.birthtimeNs += 1n;
            return info;
          },
        };
      },
    });
    const manifest = await api.plan(request(state.root));
    assert.equal((await api.observe(manifest)).state, 'present');
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});

test('path identity drift during one observation fails closed', async () => {
  const state = await fixture();
  let observations = 0;
  try {
    const target = path.join(state.root, 'first.bin');
    const api = createExactArtifactSet({
      platform: process.platform,
      ...(process.platform === 'win32' ? { inspectReparse: async (_location, info) => info.isSymbolicLink() } : {}),
      inspect: async (location, options) => {
        const info = await lstat(location, options);
        if (location === target && ++observations === 2) info.mtimeNs += 1n;
        return info;
      },
    });
    await assert.rejects(() => api.plan(request(state.root)), /changed during observation/u);
  } finally { await rm(state.parent, { recursive: true, force: true }); }
});
