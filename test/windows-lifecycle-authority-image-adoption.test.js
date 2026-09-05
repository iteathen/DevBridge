import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileWindowsLifecycleAuthorityImages } from '../src/setup/windows-lifecycle-authority-image-adoption.js';
import { IMAGE_LIBRARY_ADOPTION_PROTOCOL } from '../src/setup/image-library-adoption.js';

test('non-Windows composition remains unattached', async () => {
  const result = await reconcileWindowsLifecycleAuthorityImages({
    stateDirectory: '/unobserved/source',
    authorityDirectory: '/unobserved/destination',
    platform: 'linux',
    invoke: async () => { throw new Error('must remain unattached'); },
  });
  assert.deepEqual(result, { protocol: IMAGE_LIBRARY_ADOPTION_PROTOCOL, ready: true, changed: false, adopted: [] });
});

test('absent source inventory is a no-op and does not create destination state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-image-adoption-'));
  try {
    const destination = path.join(root, 'protected');
    const result = await reconcileWindowsLifecycleAuthorityImages({
      stateDirectory: path.join(root, 'ordinary'),
      authorityDirectory: destination,
      platform: 'win32',
      invoke: async () => { throw new Error('must remain unattached'); },
    });
    assert.deepEqual(result, { protocol: IMAGE_LIBRARY_ADOPTION_PROTOCOL, ready: true, changed: false, adopted: [] });
    await assert.rejects(() => import('node:fs/promises').then(({ lstat }) => lstat(destination)), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source filesystem indirection fails before protected composition', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-image-adoption-link-'));
  try {
    const ordinary = path.join(root, 'ordinary');
    const outside = path.join(root, 'outside');
    await mkdir(path.join(ordinary, 'environment-foundation'), { recursive: true });
    await mkdir(outside);
    try {
      await symlink(outside, path.join(ordinary, 'environment-foundation', 'images'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) return t.skip('filesystem indirection creation is unavailable');
      throw error;
    }
    await assert.rejects(() => reconcileWindowsLifecycleAuthorityImages({
      stateDirectory: ordinary,
      authorityDirectory: path.join(root, 'protected'),
      platform: 'win32',
      invoke: async () => { throw new Error('must remain unattached'); },
    }), /source must be a real directory/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
