import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileWindowsConstructionStorage } from '../src/app/windows-construction-storage.js';
import { parseSetupCommandOptions } from '../src/setup/command-options.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-windows-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  return { root, stateDirectory, location: path.join(root, 'bulk'), setting: path.join(stateDirectory, 'windows-construction-storage.json') };
}

test('Windows construction storage defaults without writing and persists explicit selection across restarts', async (t) => {
  const data = await fixture(t);
  assert.equal(await reconcileWindowsConstructionStorage(data), data.location);
  const saved = await readFile(data.setting, 'utf8');
  await writeFile(path.join(data.location, 'retained-image.vhdx'), 'retained');
  assert.equal(await reconcileWindowsConstructionStorage({ stateDirectory: data.stateDirectory }), data.location);
  assert.equal(await reconcileWindowsConstructionStorage(data), data.location);
  assert.equal(await readFile(data.setting, 'utf8'), saved);
  await assert.rejects(reconcileWindowsConstructionStorage({ ...data, location: path.join(data.root, 'elsewhere') }), /Relocating/u);
  assert.equal(await readFile(path.join(data.location, 'retained-image.vhdx'), 'utf8'), 'retained');
  const absent = path.join(data.root, 'absent-state');
  assert.equal(await reconcileWindowsConstructionStorage({ stateDirectory: absent }), null);
  await assert.rejects(lstat(absent), { code: 'ENOENT' });
});

test('Windows construction storage refuses occupied directories and existing construction without changes', async (t) => {
  const data = await fixture(t);
  await mkdir(data.location);
  await writeFile(path.join(data.location, 'unowned'), 'keep');
  await assert.rejects(reconcileWindowsConstructionStorage(data), /empty directory/u);
  await assert.rejects(lstat(data.setting), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(data.location, 'unowned'), 'utf8'), 'keep');
  for (const name of ['preparation.json', 'journal.json', path.join('construction', 'state.json')]) {
    const existing = path.join(data.stateDirectory, 'windows-production-image-canary', name);
    await mkdir(path.dirname(existing), { recursive: true });
    await writeFile(existing, '{}');
    const selected = path.join(data.root, 'new');
    await assert.rejects(reconcileWindowsConstructionStorage({ ...data, location: selected }), /before construction starts/u);
    await assert.rejects(lstat(selected), { code: 'ENOENT' });
    assert.equal(await readFile(existing, 'utf8'), '{}');
    await rm(existing);
  }
});

test('Windows construction storage rejects path aliases, roots and invalid saved state', async (t) => {
  const data = await fixture(t);
  for (const location of ['relative', '', path.parse(data.root).root, '\\\\server\\share\\bulk', `${data.root}\0bad`]) {
    await assert.rejects(reconcileWindowsConstructionStorage({ ...data, location }), /absolute local directory/u);
  }
  const target = path.join(data.root, 'target');
  const alias = path.join(data.root, 'alias');
  await mkdir(target);
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(reconcileWindowsConstructionStorage({ ...data, location: path.join(alias, 'child') }), /real directories/u);
  await assert.rejects(lstat(path.join(target, 'child')), { code: 'ENOENT' });
  await mkdir(data.stateDirectory);
  for (const saved of [{ protocol: 'other', directory: data.location }, { protocol: 'devbridge/windows-construction-storage-v1', directory: data.location, extra: true }]) {
    await writeFile(data.setting, JSON.stringify({ 'storage:v1': saved }));
    await assert.rejects(reconcileWindowsConstructionStorage(data), /setting is invalid/u);
  }
});

test('saved construction storage cannot be replaced with a junction on restart', async (t) => {
  const data = await fixture(t);
  await reconcileWindowsConstructionStorage(data);
  await rm(data.location, { recursive: true });
  const replacement = path.join(data.root, 'replacement');
  await mkdir(replacement);
  await symlink(replacement, data.location, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(reconcileWindowsConstructionStorage({ stateDirectory: data.stateDirectory }), /real directories/u);
});

test('setup parser accepts local construction storage only in the ordinary Windows setup path', () => {
  const parse = (args) => parseSetupCommandOptions(args, { platform: 'win32' });
  assert.equal(parse(['--windows-storage', 'E:\\DevBridge\\WindowsImages']).windowsStorageLocation, 'E:\\DevBridge\\WindowsImages');
  for (const args of [
    ['--windows-storage'], ['--windows-storage', 'relative'],
    ['--windows-storage', 'E:\\first', '--windows-storage', 'E:\\second'],
    ['--profiles', 'linux', '--windows-storage', 'E:\\bulk'],
    ['--lifecycle-authority-child', '--windows-storage', 'E:\\bulk'],
  ]) assert.throws(() => parse(args));
});
