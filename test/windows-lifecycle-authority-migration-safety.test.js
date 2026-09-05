import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectWindowsLifecycleAuthorityMigrationSafety } from '../src/setup/windows-lifecycle-authority-migration-safety.js';

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), 'db-win-authority-migration-safety-'));
}

async function imageCatalog(root, images = {}, operations = {}) {
  const directory = path.join(root, 'environment-foundation', 'images');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'catalog.json'), `${JSON.stringify({ protocol: 'devbridge/base-image-library-v1', revision: 1, images, operations })}\n`);
  return directory;
}

async function persistentState(root, records = {}) {
  const directory = path.join(root, 'environment-foundation', 'persistent', 'operations');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'state.json'), `${JSON.stringify({ protocol: 'devbridge/hyperv-persistent-environment-v1', records })}\n`);
  return directory;
}

test('non-Windows migration safety remains a no-op', async () => {
  const result = await inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: '/tmp/devbridge-state', platform: 'linux' });
  assert.equal(result.ready, true);
  assert.equal(result.classification, 'not-applicable');
});

test('empty legacy authority state is portable through the generic copy seam', async () => {
  const root = await fixture();
  try {
    await imageCatalog(root);
    await persistentState(root);
    const recovery = path.join(root, 'environment-foundation', 'image-recovery');
    await mkdir(path.join(recovery, 'transfer'), { recursive: true });
    await mkdir(path.join(recovery, 'quarantine'), { recursive: true });
    const result = await inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: root, platform: 'win32' });
    assert.equal(result.ready, true);
    assert.equal(result.classification, 'portable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed catalog and provider registries fail closed rather than appearing empty', async () => {
  const root = await fixture();
  try {
    const images = path.join(root, 'environment-foundation', 'images');
    await mkdir(images, { recursive: true });
    await writeFile(path.join(images, 'catalog.json'), `${JSON.stringify({ protocol: 'devbridge/base-image-library-v1', revision: 1 })}\n`);
    await assert.rejects(
      () => inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: root, platform: 'win32' }),
      /catalog shape is invalid/u,
    );

    await rm(images, { recursive: true, force: true });
    const operations = path.join(root, 'environment-foundation', 'persistent', 'operations');
    await mkdir(operations, { recursive: true });
    await writeFile(path.join(operations, 'state.json'), `${JSON.stringify({ protocol: 'devbridge/hyperv-persistent-environment-v1' })}\n`);
    await assert.rejects(
      () => inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: root, platform: 'win32' }),
      /registry shape is invalid/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('published image catalog blocks generic protected-state copying', async () => {
  const root = await fixture();
  try {
    await imageCatalog(root, { 'img-a': { fileName: 'img-a.vhdx' } });
    const result = await inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: root, platform: 'win32' });
    assert.equal(result.ready, false);
    assert.equal(result.classification, 'provider-aware-image-migration-required');
    assert.match(result.blocker, /filesystem identity/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unregistered image bytes block generic protected-state copying', async () => {
  const root = await fixture();
  try {
    const images = await imageCatalog(root);
    await mkdir(path.join(images, 'objects'), { recursive: true });
    await writeFile(path.join(images, 'objects', 'orphan.vhdx'), 'fixture');
    const result = await inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: root, platform: 'win32' });
    assert.equal(result.ready, false);
    assert.equal(result.classification, 'provider-aware-image-migration-required');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('path-bound persistent Hyper-V records block generic protected-state copying', async () => {
  const root = await fixture();
  try {
    await persistentState(root, {
      'env-a': { diskPath: 'C:\\Users\\Operator\\.devbridge\\state\\environment-foundation\\persistent\\operations\\objects\\env-a\\state.vhdx' },
    });
    const result = await inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: root, platform: 'win32' });
    assert.equal(result.ready, false);
    assert.equal(result.classification, 'provider-aware-storage-migration-required');
    assert.match(result.blocker, /path-bound provider records/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('path-bound storage remains the blocker when image adoption is also required', async () => {
  const root = await fixture();
  try {
    await imageCatalog(root, { 'img-a': { fileName: 'img-a.vhdx' } });
    await persistentState(root, {
      'env-a': { diskPath: 'C:\\Users\\Operator\\.devbridge\\state\\environment-foundation\\persistent\\operations\\objects\\env-a\\state.vhdx' },
    });
    const result = await inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: root, platform: 'win32' });
    assert.equal(result.ready, false);
    assert.equal(result.classification, 'provider-aware-storage-migration-required');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unregistered persistent backing objects block generic protected-state copying', async () => {
  const root = await fixture();
  try {
    const operations = await persistentState(root);
    await mkdir(path.join(operations, 'objects', 'env-a'), { recursive: true });
    await writeFile(path.join(operations, 'objects', 'env-a', 'state.vhdx'), 'fixture');
    const result = await inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: root, platform: 'win32' });
    assert.equal(result.ready, false);
    assert.equal(result.classification, 'provider-aware-storage-migration-required');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('active image recovery blocks migration instead of copying an ambiguous recovery transaction', async () => {
  const root = await fixture();
  try {
    const recovery = path.join(root, 'environment-foundation', 'image-recovery');
    await mkdir(path.join(recovery, 'transfer'), { recursive: true });
    await mkdir(path.join(recovery, 'quarantine'), { recursive: true });
    await writeFile(path.join(recovery, 'transfer', 'state.json'), '{}\n');
    const result = await inspectWindowsLifecycleAuthorityMigrationSafety({ stateDirectory: root, platform: 'win32' });
    assert.equal(result.ready, false);
    assert.equal(result.classification, 'provider-aware-recovery-migration-required');
  } finally { await rm(root, { recursive: true, force: true }); }
});
