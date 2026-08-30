import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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
    assert.equal(await store.observe(identity), 'indeterminate');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('any existing attempt fence blocks another claim even when its publication is incomplete', async () => {
  const { root, directory, store } = await fixture();
  try {
    await writeFile(path.join(directory, `${identity}.attempt.json`), '{', { encoding: 'utf8', flag: 'wx' });
    assert.equal(await store.observe(identity), 'indeterminate');
    assert.equal(await store.claim(identity, randomUUID()), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aggregate observation accepts only the exact current activity named by a complete fence', async () => {
  const { root, directory, store } = await fixture();
  const token = randomUUID();
  const other = randomUUID();
  try {
    assert.equal(await store.observe(identity), 'absent');
    assert.equal(await store.claim(identity, token), true);
    assert.equal(await store.observe(identity), 'indeterminate');

    await store.publish(identity, other);
    assert.equal(await store.observe(identity), 'indeterminate');

    await store.publish(identity, token);
    assert.equal(await store.observe(identity), 'current');

    await writeFile(path.join(directory, `${identity}.activity.${token}.json`), `${JSON.stringify({
      protocol: 'devbridge/activity-observation-v1', identity, token, updatedAt: Date.now() - 20_000,
    })}\n`, 'utf8');
    assert.equal(await store.observe(identity), 'indeterminate');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aggregate observation rejects substituted and widened attempt evidence', async () => {
  const { root, directory, store } = await fixture();
  const token = randomUUID();
  try {
    await writeFile(path.join(directory, `${identity}.attempt.json`), `${JSON.stringify({
      protocol: 'devbridge/activity-attempt-v1', identity, token, createdAt: Date.now(), foreign: true,
    })}\n`, { encoding: 'utf8', flag: 'wx' });
    await store.publish(identity, token);
    assert.equal(await store.observe(identity), 'indeterminate');
    assert.equal(await store.claim(identity, randomUUID()), false);

    await writeFile(path.join(directory, `${identity}.attempt.json`), `${JSON.stringify({
      protocol: 'devbridge/activity-attempt-v1', identity, token: [token], createdAt: Date.now(),
    })}\n`, 'utf8');
    assert.equal(await store.observe(identity), 'indeterminate');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aggregate observation rejects symbolic attempt evidence', async (context) => {
  const { root, directory, store } = await fixture();
  const token = randomUUID();
  try {
    const source = path.join(root, 'foreign-attempt.json');
    await writeFile(source, `${JSON.stringify({
      protocol: 'devbridge/activity-attempt-v1', identity, token, createdAt: Date.now(),
    })}\n`, 'utf8');
    try {
      await symlink(source, path.join(directory, `${identity}.attempt.json`), 'file');
    } catch (error) {
      if (process.platform === 'win32' && error?.code === 'EPERM') {
        context.skip('symbolic links are unavailable to this Windows principal');
        return;
      }
      throw error;
    }
    await store.publish(identity, token);
    assert.equal(await store.observe(identity), 'indeterminate');
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
    assert.equal(await store.observe(identity), 'indeterminate');
    assert.equal(await store.claim(identity, randomUUID()), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
