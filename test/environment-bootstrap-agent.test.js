import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { observeSequence } from '../src/guest/environment-bootstrap-agent.mjs';

const agent = fileURLToPath(new URL('../src/guest/environment-bootstrap-agent.mjs', import.meta.url));
const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function request(action, overrides = {}) {
  return {
    protocol: 'devbridge/environment-bootstrap-v1',
    request: action === 'apply' ? 'a'.repeat(32) : 'b'.repeat(32),
    target,
    action,
    body: {
      generation: '1'.repeat(64),
      basisDigest: '2'.repeat(64),
      revision: 'test-v1',
      requirements: ['runtime-js'],
      protectedNames: [],
      networkRequired: false,
      ...overrides,
    },
  };
}

async function exchange(root, frame, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agent, '--exchange-stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, DEVBRIDGE_BOOTSTRAP_ROOT: root, DEVBRIDGE_GUEST_TARGET: target, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', () => {
      try { resolve({ response: JSON.parse(stdout.trim()), stderr }); }
      catch (error) { reject(new Error(`invalid agent output: ${stdout} ${stderr}`, { cause: error })); }
    });
    child.stdin.end(JSON.stringify(frame));
  });
}

test('ordered observation admits one local operation at a time and preserves input order', async () => {
  let active = 0;
  let maximum = 0;
  const started = [];
  const results = await observeSequence(['first', 'second', 'third'], async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    started.push(value);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return `${value}-observed`;
  });
  assert.equal(maximum, 1);
  assert.deepEqual(started, ['first', 'second', 'third']);
  assert.deepEqual(results, ['first-observed', 'second-observed', 'third-observed']);
});

test('ordered observation stops at rejection and validates only its local contract', async () => {
  const started = [];
  await assert.rejects(
    () => observeSequence(['first', 'second', 'third'], async (value) => {
      started.push(value);
      if (value === 'second') throw new Error('observation failed');
      return value;
    }),
    /observation failed/u,
  );
  assert.deepEqual(started, ['first', 'second']);
  await assert.rejects(() => observeSequence('first', async () => null), /values are invalid/u);
  await assert.rejects(() => observeSequence([], null), /function is invalid/u);
});

test('guest bootstrap state persists across helper process restart and records exact generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bootstrap-agent-'));
  try {
    const applied = await exchange(root, request('apply'));
    assert.equal(applied.response.ok, true);
    assert.equal(applied.response.body.generation, '1'.repeat(64));
    const inspected = await exchange(root, request('inspect'));
    assert.equal(inspected.response.ok, true);
    assert.equal(inspected.response.body.generation, '1'.repeat(64));
    assert.equal(inspected.response.body.capabilities[0].id, 'runtime-js');
    assert.equal(inspected.response.body.capabilities[0].present, true);
    assert.equal(inspected.response.body.capabilities[0].usable, true);
    const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    assert.equal(state.target, target);
    assert.equal(state.generation, '1'.repeat(64));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('guest bootstrap reports protected names only and never returns their values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bootstrap-secret-'));
  const sentinel = 'DO-NOT-RETURN-THIS-SECRET-7f8a0f';
  try {
    const frame = request('inspect', { protectedNames: ['GITHUB_TOKEN'] });
    const result = await exchange(root, frame, { GITHUB_TOKEN: sentinel });
    assert.equal(result.response.ok, true);
    assert.deepEqual(result.response.body.protectedPresent, ['GITHUB_TOKEN']);
    assert.equal(JSON.stringify(result.response).includes(sentinel), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown capability is absent rather than silently executable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bootstrap-unknown-'));
  try {
    const result = await exchange(root, request('inspect', { requirements: ['made-up-capability'] }));
    assert.equal(result.response.ok, true);
    assert.deepEqual(result.response.body.capabilities.map(({ id, present, usable }) => ({ id, present, usable })), [
      { id: 'made-up-capability', present: false, usable: false },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('guest baseline observes real Node Git CMake CTest compiler and project-package workflows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bootstrap-baseline-'));
  try {
    const required = ['source-control', 'runtime-js', 'build-config', 'test-runner', 'compiler-c', 'compiler-cxx', 'package-project'];
    const result = await exchange(root, request('inspect', { requirements: required }));
    assert.equal(result.response.ok, true);
    const byId = new Map(result.response.body.capabilities.map((entry) => [entry.id, entry]));
    for (const id of required) {
      if (process.platform === 'win32' && ['compiler-c', 'compiler-cxx'].includes(id) && byId.get(id)?.present === false) {
        assert.match(byId.get(id).reason, /not found/u);
        continue;
      }
      assert.equal(byId.get(id)?.present, true, `${id} should be present`);
      assert.equal(byId.get(id)?.usable, true, `${id} should pass its bounded real probe`);
      assert.ok(byId.get(id)?.version, `${id} should expose bounded version evidence`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
