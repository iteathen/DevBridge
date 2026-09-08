import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyFileGuard } from '../src/runtime/legacy-file-guard.js';
import { mutationLease } from '../test-support/mutation-lease.js';

const TOKEN = '01234567-1234-5678-abcd-012345678901\n';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-legacy-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guardFile = path.join(root, 'lifecycle.lock');
  await writeFile(guardFile, TOKEN);
  return { guardFile, lease: mutationLease(root), assertQuiescent: async () => {} };
}

test('quiescent migration retains exact legacy evidence under an exclusive lease and is repeatable', async (t) => {
  const request = await fixture(t);
  let observations = 0;
  request.assertQuiescent = async () => { observations++; };
  assert.deepEqual(await migrateLegacyFileGuard(request), { changed: true });
  assert.equal(observations, 3);
  assert.equal(await readFile(`${request.guardFile}.retired-${TOKEN.trim()}`, 'utf8'), TOKEN);
  assert.deepEqual(await migrateLegacyFileGuard(request), { changed: false });
  const held = await request.lease.acquire({ mode: 'exclusive' });
  assert.ok(held);
  await held.release();
});

test('an active old authority or competing new owner preserves the legacy token', async (t) => {
  const request = await fixture(t);
  await assert.rejects(migrateLegacyFileGuard({ ...request, assertQuiescent: async () => { throw new Error('still running'); } }), /still running/u);
  const held = await request.lease.acquire({ mode: 'exclusive' });
  await assert.rejects(migrateLegacyFileGuard(request), /exclusive ownership/u);
  assert.equal(await readFile(request.guardFile, 'utf8'), TOKEN);
  await held.release();
});

test('guard substitution and renewed old authority are checked immediately before retirement', async (t) => {
  const request = await fixture(t);
  let observations = 0;
  request.assertQuiescent = async () => {
    observations++;
    if (observations === 3) await writeFile(request.guardFile, TOKEN.replace('01234567-', 'aaaaaaaa-'));
  };
  await assert.rejects(migrateLegacyFileGuard(request), /changed during migration/u);
  assert.equal(await readFile(request.guardFile, 'utf8'), TOKEN.replace('01234567-', 'aaaaaaaa-'));
  observations = 0;
  request.assertQuiescent = async () => { if (++observations === 3) throw new Error('authority restarted'); };
  await assert.rejects(migrateLegacyFileGuard(request), /authority restarted/u);
});

test('unrecognized legacy content cannot be adopted or retired', async (t) => {
  const request = await fixture(t);
  await writeFile(request.guardFile, 'foreign');
  await assert.rejects(migrateLegacyFileGuard(request), /token is invalid/u);
  assert.equal(await readFile(request.guardFile, 'utf8'), 'foreign');
});
