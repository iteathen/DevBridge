import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  LINUX_LOCAL_SOCKET_PREPARATION_PROTOCOL,
  prepareLinuxLocalSocket,
} from '../src/setup/linux-local-socket-preparation.js';

const DIRECTORY = '/run/devbridge/authority/activity';
const ENDPOINT = `${DIRECTORY}/environment-v1.sock`;
const OWNER = 991;
const GROUP = 993;

function info(kind, { uid = OWNER, gid = GROUP, mode = kind === 'directory' ? 0o2750 : 0o770, nlink = 1 } = {}) {
  return Object.freeze({
    uid,
    gid,
    mode,
    nlink,
    isDirectory: () => kind === 'directory',
    isSocket: () => kind === 'socket',
    isSymbolicLink: () => kind === 'symlink',
  });
}

function fixture(endpoint = null) {
  const entries = new Map([[DIRECTORY, info('directory')]]);
  if (endpoint != null) entries.set(ENDPOINT, endpoint);
  const calls = [];
  return {
    entries,
    calls,
    ports: {
      async inspect(target) {
        calls.push(['inspect', target]);
        if (entries.has(target)) return entries.get(target);
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      async remove(target) {
        calls.push(['remove', target]);
        entries.delete(target);
      },
    },
  };
}

function prepare(values) {
  return prepareLinuxLocalSocket({
    endpoint: ENDPOINT,
    directoryOwnerId: OWNER,
    directoryGroupIds: [GROUP],
    directoryMode: 0o2750,
    socketOwnerId: OWNER,
    socketGroupId: GROUP,
    socketMode: 0o770,
  }, values.ports);
}

test('local socket preparation preserves an absent endpoint and removes only exact stale residue', async () => {
  const absent = fixture();
  assert.deepEqual(await prepare(absent), {
    protocol: LINUX_LOCAL_SOCKET_PREPARATION_PROTOCOL,
    ready: true,
    changed: false,
    endpoint: ENDPOINT,
  });
  assert.equal(absent.calls.some(([name]) => name === 'remove'), false);

  const stale = fixture(info('socket'));
  assert.deepEqual(await prepare(stale), {
    protocol: LINUX_LOCAL_SOCKET_PREPARATION_PROTOCOL,
    ready: true,
    changed: true,
    endpoint: ENDPOINT,
  });
  assert.deepEqual(stale.calls.filter(([name]) => name === 'remove'), [['remove', ENDPOINT]]);
});

test('local socket preparation rejects unsafe parents before inspecting or removing residue', async () => {
  for (const replacement of [
    info('symlink'),
    info('directory', { uid: OWNER + 1 }),
    info('directory', { gid: GROUP + 1 }),
    info('directory', { mode: 0o2770 }),
  ]) {
    const values = fixture(info('socket'));
    values.entries.set(DIRECTORY, replacement);
    await assert.rejects(prepare(values), /directory authority is invalid/u);
    assert.equal(values.calls.some(([name]) => name === 'remove'), false);
  }
  await assert.rejects(() => prepareLinuxLocalSocket({
    endpoint: ENDPOINT,
    directoryOwnerId: OWNER,
    directoryGroupIds: [GROUP],
    directoryMode: 0o2770,
    socketOwnerId: OWNER,
    socketGroupId: GROUP,
  }), /must not be writable/u);
});

test('local socket preparation rejects foreign, linked, widened, and non-socket endpoints', async () => {
  for (const replacement of [
    info('symlink'),
    info('file'),
    info('socket', { uid: OWNER + 1 }),
    info('socket', { gid: GROUP + 1 }),
    info('socket', { mode: 0o777 }),
    info('socket', { nlink: 2 }),
  ]) {
    const values = fixture(replacement);
    await assert.rejects(prepare(values), /endpoint authority is invalid/u);
    assert.equal(values.calls.some(([name]) => name === 'remove'), false);
  }
});

test('local socket preparation fails if a path reappears after exact unlink', async () => {
  const values = fixture(info('socket'));
  values.ports.remove = async (target) => { values.calls.push(['remove', target]); };
  await assert.rejects(prepare(values), /changed during reconciliation/u);
});

test('local socket preparation removes a real crash-retained Linux pathname socket', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'devbridge-local-socket-'));
  const endpoint = path.join(directory, 'environment-v1.sock');
  let child = null;
  try {
    await chmod(directory, 0o700);
    child = spawn(process.execPath, [
      '-e',
      'const net=require("node:net");process.umask(0o007);const server=net.createServer(()=>{});server.listen(process.argv[1],()=>process.stdout.write("ready\\n"));setInterval(()=>{},1000);',
      endpoint,
    ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.race([
      once(child.stdout, 'data').then(([chunk]) => {
        if (chunk.toString('utf8') !== 'ready\n') throw new Error('socket child emitted invalid readiness');
      }),
      once(child, 'exit').then(() => { throw new Error('socket child exited before readiness'); }),
      wait(5_000).then(() => { throw new Error('socket child readiness timed out'); }),
    ]);
    const completion = once(child, 'exit');
    child.kill('SIGKILL');
    await completion;
    child = null;
    const retained = await lstat(endpoint);
    assert.equal(retained.isSocket(), true);
    assert.equal(retained.mode & 0o7777, 0o770);
    assert.deepEqual(await prepareLinuxLocalSocket({
      endpoint,
      directoryOwnerId: process.getuid(),
      directoryGroupIds: [process.getgid()],
      directoryMode: 0o700,
      socketOwnerId: process.getuid(),
      socketGroupId: process.getgid(),
      socketMode: 0o770,
    }), {
      protocol: LINUX_LOCAL_SOCKET_PREPARATION_PROTOCOL,
      ready: true,
      changed: true,
      endpoint,
    });
    await assert.rejects(lstat(endpoint), (error) => error?.code === 'ENOENT');
  } finally {
    child?.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
