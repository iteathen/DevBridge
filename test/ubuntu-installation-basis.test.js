import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UBUNTU_INSTALLATION_BASIS_PATH, ubuntuInstallationBasisCaptureCommand } from '../src/runtime/image-builders/ubuntu-installation-basis.js';

const STATUS = 'Package: base\nStatus: install ok installed\nArchitecture: amd64\nVersion: 1\n\n';
const POSIX = { skip: process.platform !== 'linux' ? 'requires actual Linux shell/coreutils filesystem semantics' : false };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-installation-basis-'));
  const target = path.join(root, "target with ' literal $ text");
  const status = path.join(target, 'var/lib/dpkg/status');
  const record = path.join(target, UBUNTU_INSTALLATION_BASIS_PATH.slice(1));
  await mkdir(path.dirname(status), { recursive: true });
  await writeFile(status, STATUS);
  return { root, target, status, record };
}

function capture(f, env = process.env) {
  const [program, ...args] = ubuntuInstallationBasisCaptureCommand(f.target);
  return spawnSync(program, args, { encoding: 'utf8', env, timeout: 10_000 });
}

test('installation basis command has one fixed record owner and rejects ambiguous target roots', () => {
  const command = ubuntuInstallationBasisCaptureCommand('/target');
  assert.ok(Object.isFrozen(command));
  assert.deepEqual(command.slice(0, 2), ['sh', '-c']);
  assert.equal(command.at(-1), '/target');
  assert.ok(command[2].includes(UBUNTU_INSTALLATION_BASIS_PATH));
  assert.doesNotMatch(command[2], /apt-get|snapshot|Hyper-V|libvirt|sudo/u);
  for (const target of [null, '', '/', '/target/', '/target/../else', '/target/./else', '//target', 'C:\\target', '/target\\else', '/target\nelse']) {
    assert.throws(() => ubuntuInstallationBasisCaptureCommand(target), /direct absolute guest path/u);
  }
});

test('actual capture is exact, read-only, single-link and stable on unchanged replay', POSIX, async () => {
  const f = await fixture();
  try {
    assert.equal(capture(f).status, 0);
    assert.equal(await readFile(f.record, 'utf8'), STATUS);
    const first = await lstat(f.record, { bigint: true });
    assert.equal(first.nlink, 1n);
    assert.equal(Number(first.mode & 0o777n), 0o444);
    assert.equal(capture(f).status, 0);
    const replay = await lstat(f.record, { bigint: true });
    assert.equal(replay.ino, first.ino);
    assert.equal(replay.mtimeNs, first.mtimeNs);
    await writeFile(f.status, STATUS.replace('Version: 1', 'Version: 2'));
    const changed = capture(f);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /original record retained/u);
    assert.equal(await readFile(f.record, 'utf8'), STATUS);
    assert.deepEqual(await readdir(path.dirname(f.record)), [path.basename(f.record)]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const kind of ['empty source', 'source directory', 'source symlink', 'source hardlink', 'record directory', 'record symlink', 'record hardlink', 'parent symlink']) {
  test(`basis rejects ${kind} without replacing foreign state`, POSIX, async () => {
    const f = await fixture();
    try {
      const sentinel = path.join(f.root, 'sentinel');
      await writeFile(sentinel, 'unrelated');
      if (kind === 'empty source') await writeFile(f.status, '');
      if (kind === 'source directory') { await rm(f.status); await mkdir(f.status); }
      if (kind === 'source symlink') { await rm(f.status); await symlink(sentinel, f.status); }
      if (kind === 'source hardlink') await link(f.status, path.join(f.root, 'status-alias'));
      if (kind.startsWith('record ')) {
        await mkdir(path.dirname(f.record), { recursive: true });
        if (kind === 'record directory') await mkdir(f.record);
        else if (kind === 'record hardlink') await link(sentinel, f.record);
        else await symlink(sentinel, f.record);
      }
      if (kind === 'parent symlink') await symlink(f.root, path.join(f.target, 'var/lib/devbridge'));
      const result = capture(f);
      assert.notEqual(result.status, 0);
      assert.equal(await readFile(sentinel, 'utf8'), 'unrelated');
      if (kind.startsWith('source ') || kind === 'empty source') {
        await assert.rejects(lstat(path.join(f.target, 'var/lib/devbridge')), /ENOENT/u);
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const failure of ['partial copy', 'publication collision', 'interruption']) {
  test(`basis cleans only its staging file after ${failure} and supports retry`, POSIX, async () => {
    const f = await fixture();
    try {
      const bin = path.join(f.root, 'bin');
      await mkdir(bin);
      const tool = failure === 'publication collision' ? 'ln' : 'cat';
      const script = failure === 'publication collision'
        ? '#!/bin/sh\nfor record do :; done\nprintf foreign >"$record"\nexec /usr/bin/ln "$@"\n'
        : failure === 'interruption'
          ? '#!/bin/sh\nprintf partial\nkill -TERM "$PPID"\nexit 43\n'
          : '#!/bin/sh\nprintf partial\nexit 43\n';
      await writeFile(path.join(bin, tool), script);
      await chmod(path.join(bin, tool), 0o755);
      const result = capture(f, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
      assert.notEqual(result.status, 0);
      assert.equal(result.error, undefined, 'bounded process completed rather than hanging');
      const names = await readdir(path.dirname(f.record));
      assert.equal(names.some((name) => name.startsWith('.ubuntu-installation-basis.')), false);
      if (failure === 'publication collision') {
        assert.equal(await readFile(f.record, 'utf8'), 'foreign');
        assert.notEqual(capture(f).status, 0, 'foreign state is not repaired on retry');
      } else {
        await assert.rejects(lstat(f.record), /ENOENT/u);
        assert.equal(capture(f).status, 0);
        assert.equal(await readFile(f.record, 'utf8'), STATUS);
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('uncatchable interruption retains uncertain links and retry does not erase evidence', POSIX, async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.root, 'bin');
    await mkdir(bin);
    const tool = path.join(bin, 'ln');
    await writeFile(tool, '#!/bin/sh\n/usr/bin/ln "$@" || exit $?\nkill -KILL "$PPID"\n');
    await chmod(tool, 0o755);
    const result = capture(f, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.signal, 'SIGKILL');
    const names = await readdir(path.dirname(f.record));
    assert.equal(names.length, 2);
    assert.equal(await readFile(f.record, 'utf8'), STATUS);
    assert.equal((await lstat(f.record)).nlink, 2);
    const replay = capture(f);
    assert.notEqual(replay.status, 0);
    assert.match(replay.stderr, /unexpected links/u);
    assert.deepEqual(await readdir(path.dirname(f.record)), names);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed staging cleanup is not reported as successful capture', POSIX, async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.root, 'bin');
    await mkdir(bin);
    const tool = path.join(bin, 'rm');
    await writeFile(tool, '#!/bin/sh\nexit 43\n');
    await chmod(tool, 0o755);
    const result = capture(f, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /staging cleanup failed; evidence retained/u);
    assert.equal((await lstat(f.record)).nlink, 2);
    assert.equal(await readFile(f.record, 'utf8'), STATUS);
    assert.notEqual(capture(f).status, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
