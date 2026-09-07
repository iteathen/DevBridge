import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActivityStore } from '../src/guest/activity-store.mjs';

const agent = fileURLToPath(new URL('../src/guest/bridge-agent.mjs', import.meta.url));
const protocol = 'devbridge/environment-bridge-v1';
const recordProtocol = 'devbridge/environment-bridge-operation-v2';
const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const nodeProgram = path.basename(process.execPath);

async function exchange(root, request, kind, body = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agent, '--exchange-stdin'], {
      env: { ...process.env, DEVBRIDGE_GUEST_BRIDGE_ROOT: root, DEVBRIDGE_GUEST_TARGET: target },
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString('utf8') || `agent exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (error) { reject(new Error(`invalid agent output: ${out}`, { cause: error })); }
    });
    child.stdin.end(JSON.stringify({ protocol, request, target, kind, body }));
  });
}

function operation() {
  return {
    program: nodeProgram,
    arguments: ['-e', 'setTimeout(()=>{}, 10000)'],
    directory: { class: 'work', path: '.' },
    environment: {},
    input: null,
    timeoutMs: 20_000,
    maxOutputBytes: 4096,
  };
}

async function seedRunning(root, request, token, extra = {}) {
  const operations = path.join(root, '.operations');
  await mkdir(operations, { recursive: true });
  const body = operation();
  const record = {
    protocol: recordProtocol,
    request,
    target,
    digest: createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex'),
    body,
    state: 'running',
    createdAt: new Date().toISOString(),
    activityToken: token,
    result: null,
    reason: null,
    attemptedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    ...extra,
  };
  await writeFile(path.join(operations, `${request}.json`), `${JSON.stringify(record)}\n`, 'utf8');
  return { operations, store: await createActivityStore({ directory: operations }) };
}

async function seedPlanned(root, request) {
  const operations = path.join(root, '.operations');
  await mkdir(operations, { recursive: true });
  const body = operation();
  await writeFile(path.join(operations, `${request}.json`), `${JSON.stringify({
    protocol: recordProtocol,
    request,
    target,
    digest: createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex'),
    body,
    state: 'planned',
    createdAt: new Date().toISOString(),
    activityToken: null,
    result: null,
    reason: null,
  })}\n`, 'utf8');
  return { operations, store: await createActivityStore({ directory: operations }) };
}

test('planned observation recognizes the exact current attempt while journal publication catches up', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-current-attempt-'));
  const request = 'b'.repeat(32);
  const token = randomUUID();
  try {
    const { store } = await seedPlanned(root, request);
    assert.equal(await store.claim(request, token), true);
    await store.publish(request, token);
    const observed = await exchange(root, request, 'observe');
    assert.equal(observed.ok, true);
    assert.deepEqual(observed.body, { state: 'running', result: null, reason: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('running observation requires the exact current activity token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-current-activity-'));
  const request = 'e'.repeat(32);
  const token = randomUUID();
  try {
    const { store } = await seedRunning(root, request, token);
    assert.equal(await store.claim(request, token), true);
    await store.publish(request, token);
    const observed = await exchange(root, request, 'observe');
    assert.equal(observed.ok, true);
    assert.equal(observed.body.state, 'running');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale activity is indeterminate even when a foreign process currently exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-stale-activity-'));
  const request = 'f'.repeat(32);
  const token = randomUUID();
  const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { stdio: 'ignore', shell: false, windowsHide: true });
  try {
    const { operations, store } = await seedRunning(root, request, token);
    assert.equal(await store.claim(request, token), true);
    await writeFile(path.join(operations, `${request}.activity.${token}.json`), `${JSON.stringify({
      protocol: 'devbridge/activity-observation-v1', identity: request, token, updatedAt: Date.now() - 20_000,
    })}\n`, 'utf8');
    const observed = await exchange(root, request, 'observe');
    assert.equal(observed.ok, true);
    assert.equal(observed.body.state, 'indeterminate');
    assert.equal(observed.body.reason, 'bridge operation activity is no longer current');
    assert.equal(foreign.exitCode, null);
  } finally {
    foreign.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('version-1 durable operation records fail closed without compatibility parsing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-v1-record-'));
  const request = 'd'.repeat(32);
  try {
    const operations = path.join(root, '.operations');
    await mkdir(operations, { recursive: true });
    await writeFile(path.join(operations, `${request}.json`), `${JSON.stringify({
      protocol: 'devbridge/environment-bridge-operation-v1', request, target, state: 'running',
      monitorPid: process.pid, childPid: process.pid,
    })}\n`, 'utf8');
    const observed = await exchange(root, request, 'observe');
    assert.equal(observed.ok, false);
    assert.match(observed.error.message, /record.*not allowed|identity is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation rejects injected process locators and leaves the unrelated process alone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-cancel-injected-'));
  const request = 'c'.repeat(32);
  const token = randomUUID();
  const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { stdio: 'ignore', shell: false, windowsHide: true });
  try {
    const { store } = await seedRunning(root, request, token, { childPid: foreign.pid });
    assert.equal(await store.claim(request, token), true);
    await store.publish(request, token);
    const cancelled = await exchange(root, request, 'cancel', { reason: 'abort' });
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.error.message, /childPid is not allowed/u);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(foreign.exitCode, null);
  } finally {
    foreign.kill();
    await rm(root, { recursive: true, force: true });
  }
});
