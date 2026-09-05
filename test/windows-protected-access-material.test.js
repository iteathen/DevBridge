import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCommand } from '../src/runtime/command-invocation.js';
import { WindowsProtectedAccessMaterial } from '../src/runtime/providers/windows-protected-access-material.js';

const IDENTITY = `subject-${'7'.repeat(32)}`;
const FIXED_BYTES = Buffer.alloc(32, 11);

function fakeInvoke(calls) {
  return async (request) => {
    calls.push(structuredClone(request));
    const input = JSON.parse(request.input);
    const unprotecting = Object.hasOwn(input, 'protected');
    const output = unprotecting ? { value: input.protected } : { protected: input.value };
    return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(output), stderr: '' };
  };
}

test('Windows protected access material persists only a user-scoped protected blob and exact digest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-access-material-'));
  const calls = [];
  try {
    const material = new WindowsProtectedAccessMaterial({ directory: root, invoke: fakeInvoke(calls), user: 'Administrator', platform: 'win32', entropy: () => FIXED_BYTES });
    const first = await material.ensure(IDENTITY);
    assert.deepEqual(first, { identity: IDENTITY, user: 'Administrator', created: true });
    const secret = (await material.resolve(IDENTITY)).secret;
    assert.match(secret, /^Db!A9-/u);
    const [file] = await readdir(root);
    const persisted = await readFile(path.join(root, file), 'utf8');
    assert.equal(persisted.includes(secret), false);
    assert.match(persisted, /protectedSecret/u);
    assert.equal(calls.every(({ arguments: args }) => args.includes(secret) === false), true);
    assert.deepEqual(await material.ensure(IDENTITY), { identity: IDENTITY, user: 'Administrator', created: false });
    assert.equal((await material.resolve(IDENTITY)).secret, secret);
    assert.deepEqual(await material.discard(IDENTITY), { identity: IDENTITY, discarded: true });
    assert.deepEqual(await material.discard(IDENTITY), { identity: IDENTITY, discarded: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows protected access material fails closed off Windows and on substituted records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-access-denial-'));
  try {
    const unavailable = new WindowsProtectedAccessMaterial({ directory: root, invoke: fakeInvoke([]), user: 'devbridge', platform: 'linux' });
    await assert.rejects(() => unavailable.ensure(IDENTITY), /unavailable on this host/u);
    assert.throws(() => new WindowsProtectedAccessMaterial({ directory: 'relative', invoke: fakeInvoke([]), user: 'devbridge' }), /directory is invalid/u);
    assert.throws(() => new WindowsProtectedAccessMaterial({ directory: root, invoke: fakeInvoke([]) }), /user is invalid/u);

    const material = new WindowsProtectedAccessMaterial({ directory: root, invoke: fakeInvoke([]), user: 'devbridge', platform: 'win32', entropy: () => FIXED_BYTES });
    const target = `env-${'8'.repeat(32)}`;
    await material.ensure(target);
    const [file] = await readdir(root);
    const record = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    await writeFile(path.join(root, file), `${JSON.stringify({ ...record, user: 'Administrator' })}\n`, 'utf8');
    await assert.rejects(() => material.resolve(target), /identity changed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows protected access material binds a persistent environment to its fixed non-admin user', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-access-environment-'));
  const target = `env-${'9'.repeat(32)}`;
  try {
    const material = new WindowsProtectedAccessMaterial({ directory: root, invoke: fakeInvoke([]), user: 'devbridge', platform: 'win32', entropy: () => FIXED_BYTES });
    assert.deepEqual(await material.ensure(target), { identity: target, user: 'devbridge', created: true });
    assert.equal((await material.resolve(target)).user, 'devbridge');
    await assert.rejects(() => material.resolve(`profile-${'9'.repeat(32)}`), /identity is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows protected access material completes a real current-user protection round trip', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-access-real-'));
  try {
    const material = new WindowsProtectedAccessMaterial({ directory: root, invoke: invokeCommand, user: 'Administrator', entropy: () => FIXED_BYTES });
    await material.ensure(IDENTITY);
    const resolved = await material.resolve(IDENTITY);
    assert.equal(resolved.user, 'Administrator');
    assert.match(resolved.secret, /^Db!A9-/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows protected access adapter stays independent from VM, repository, and remote topology', async () => {
  const source = await readFile(new URL('../src/runtime/providers/windows-protected-access-material.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /HyperV|libvirt|GitHub|repository[A-Z]|branch|pull request|Codex|CUDA/iu);
});
