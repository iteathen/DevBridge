import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createActivityStore } from '../src/guest/activity-store.mjs';

const identity = 'a'.repeat(32);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-activity-store-'));
  const directory = path.join(root, 'records');
  await mkdir(directory);
  return { root, directory, store: await createActivityStore({ directory }) };
}

test('exactly one token can claim the immutable attempt fence', async () => {
  const { root, store } = await fixture();
  try {
    const tokens = Array.from({ length: 8 }, () => randomUUID());
    const claims = await Promise.all(tokens.map((token) => store.claim(identity, token)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await store.attempted(identity), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('any existing attempt fence blocks another claim even when its publication is incomplete', async () => {
  const { root, directory, store } = await fixture();
  try {
    await writeFile(path.join(directory, `${identity}.attempt.json`), '{', { encoding: 'utf8', flag: 'wx' });
    assert.equal(await store.attempted(identity), true);
    assert.equal(await store.claim(identity, randomUUID()), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('activity observation requires the exact current token and strict record shape', async () => {
  const { root, directory, store } = await fixture();
  const token = randomUUID();
  try {
    assert.equal(await store.inspect(identity, token), 'absent');
    await store.publish(identity, token);
    assert.equal(await store.inspect(identity, token), 'current');

    const file = path.join(directory, `${identity}.activity.${token}.json`);
    await writeFile(file, `${JSON.stringify({
      protocol: 'devbridge/activity-observation-v1', identity, token, updatedAt: Date.now() - 20_000,
    })}\n`, 'utf8');
    assert.equal(await store.inspect(identity, token), 'stale');

    await writeFile(file, `${JSON.stringify({
      protocol: 'devbridge/activity-observation-v1', identity, token: randomUUID(), updatedAt: Date.now(),
    })}\n`, 'utf8');
    assert.equal(await store.inspect(identity, token), 'invalid');

    await writeFile(file, `${JSON.stringify({
      protocol: 'devbridge/activity-observation-v1', identity, token, updatedAt: Date.now(), pid: process.pid,
    })}\n`, 'utf8');
    assert.equal(await store.inspect(identity, token), 'invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('activity removal is limited to the exact token path and never removes the attempt fence', async () => {
  const { root, store } = await fixture();
  const token = randomUUID();
  try {
    assert.equal(await store.claim(identity, token), true);
    await store.publish(identity, token);
    await store.remove(identity, token);
    assert.equal(await store.inspect(identity, token), 'absent');
    assert.equal(await store.attempted(identity), true);
    assert.equal(await store.claim(identity, randomUUID()), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
