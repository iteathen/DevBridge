import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UbuntuSnapshotAptLists } from '../src/release/ubuntu-snapshot-apt-lists.mjs';

const SNAPSHOT = '20260821T230000Z';
const CODENAME = 'resolute';
const ARCHITECTURE = 'amd64';

function names() {
  const prefix = `snapshot.ubuntu.com_ubuntu_${SNAPSHOT}_dists_`;
  return [
    `${prefix}${CODENAME}-security_InRelease`,
    `${prefix}${CODENAME}-security_main_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}-security_universe_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}-updates_InRelease`,
    `${prefix}${CODENAME}-updates_main_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}-updates_universe_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}_InRelease`,
    `${prefix}${CODENAME}_main_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}_universe_binary-${ARCHITECTURE}_Packages`,
  ].sort();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-snapshot-lists-'));
  const destination = path.join(root, 'workspace');
  const executable = path.join(root, 'apt-get');
  const statusFile = path.join(destination, 'status');
  const keyringFile = path.join(destination, 'keyring.gpg');
  await mkdir(destination);
  await Promise.all([
    writeFile(executable, 'tool'),
    writeFile(statusFile, 'status'),
    writeFile(keyringFile, 'keyring'),
  ]);
  return { root, destination, executable, statusFile, keyringFile };
}

function request(f) {
  return {
    destination: f.destination,
    statusFile: f.statusFile,
    keyringFile: f.keyringFile,
    sources: `deb [arch=amd64 snapshot=yes signed-by=${f.keyringFile}] http://archive.ubuntu.com/ubuntu resolute main universe\n`,
    codename: CODENAME,
    architecture: ARCHITECTURE,
    snapshot: SNAPSHOT,
    signal: null,
  };
}

test('snapshot adapter performs one exact update and retains only the nine solver-authority files', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const adapter = new UbuntuSnapshotAptLists({
      executable: f.executable,
      async run(executable, args, options) {
        calls += 1;
        assert.equal(executable, f.executable);
        assert.ok(args.includes('--error-on=any'));
        assert.deepEqual(args.slice(args.indexOf('--snapshot'), args.indexOf('--snapshot') + 2), ['--snapshot', SNAPSHOT]);
        assert.equal(args.at(-2), 'update');
        assert.equal(options.environment.LANG, 'C');
        const lists = args.find((value) => value.startsWith('Dir::State::lists=')).split('=')[1];
        await Promise.all([mkdir(path.join(lists, 'partial')), mkdir(path.join(lists, 'auxfiles'))]);
        await Promise.all([
          writeFile(path.join(lists, 'lock'), 'lock'),
          writeFile(path.join(lists, 'archive.ubuntu.com_live_Packages'), 'live'),
          ...names().map((name) => writeFile(path.join(lists, name), `fixture:${name}`)),
        ]);
        return { code: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    const result = await adapter.prepare(request(f));
    assert.equal(calls, 1);
    assert.deepEqual((await readdir(result.listsDirectory)).sort(), names());
    assert.deepEqual(await readdir(result.sourcePartsDirectory), []);
    await assert.rejects(lstat(path.join(result.listsDirectory, 'partial')), /ENOENT/u);
    await assert.rejects(lstat(path.join(result.listsDirectory, 'archive.ubuntu.com_live_Packages')), /ENOENT/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('snapshot adapter rejects a failed update without retrying', async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const adapter = new UbuntuSnapshotAptLists({
      executable: f.executable,
      async run() {
        calls += 1;
        return { code: 100, signal: null, stdout: '', stderr: 'network unavailable' };
      },
    });
    await assert.rejects(adapter.prepare(request(f)), /network unavailable/u);
    assert.equal(calls, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
