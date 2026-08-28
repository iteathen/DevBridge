import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectStateRoot } from '../src/guest/bridge-agent.mjs';

const agent = fileURLToPath(new URL('../src/guest/bridge-agent.mjs', import.meta.url));
const protocol = 'devbridge/environment-bridge-v1';
const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const nodeProgram = path.basename(process.execPath);

async function exchange(root, frame, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agent, '--exchange-stdin'], {
      env: { ...process.env, DEVBRIDGE_GUEST_BRIDGE_ROOT: root, DEVBRIDGE_GUEST_TARGET: target, ...env },
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
    child.stdin.end(JSON.stringify(frame));
  });
}

function frame(request, kind, body = {}) { return { protocol, request, target, kind, body }; }

test('state root selection is local, persistent, absolute, and platform bounded', () => {
  assert.equal(
    selectStateRoot({ platform: 'linux', homeDirectory: '/home/local', variables: {} }),
    '/home/local/.local/state/devbridge/bridge',
  );
  assert.equal(
    selectStateRoot({ platform: 'linux', homeDirectory: '/ignored', variables: { XDG_STATE_HOME: '/state/local' } }),
    '/state/local/devbridge/bridge',
  );
  assert.equal(
    selectStateRoot({ platform: 'linux', homeDirectory: '/ignored', variables: { DEVBRIDGE_GUEST_BRIDGE_ROOT: '/state/explicit' } }),
    '/state/explicit',
  );
  assert.equal(
    selectStateRoot({ platform: 'win32', variables: { ProgramData: 'D:\\ProgramData' } }),
    'D:\\ProgramData\\DevBridge\\bridge',
  );
  assert.throws(
    () => selectStateRoot({ platform: 'linux', homeDirectory: '/home/local', variables: { DEVBRIDGE_GUEST_BRIDGE_ROOT: 'relative' } }),
    /configured state root must be absolute/u,
  );
  assert.throws(
    () => selectStateRoot({ platform: 'linux', homeDirectory: '/home/local', variables: { DEVBRIDGE_GUEST_BRIDGE_ROOT: '/' } }),
    /configured state root must not be a filesystem root/u,
  );
  assert.throws(
    () => selectStateRoot({ platform: 'win32', variables: { DEVBRIDGE_GUEST_BRIDGE_ROOT: 'C:\\' } }),
    /configured state root must not be a filesystem root/u,
  );
  assert.throws(
    () => selectStateRoot({ platform: 'linux', homeDirectory: '/home/local', variables: { XDG_STATE_HOME: 'relative' } }),
    /state base must be absolute/u,
  );
  assert.throws(
    () => selectStateRoot({ platform: 'linux', homeDirectory: 'relative', variables: {} }),
    /home directory must be absolute/u,
  );
});

test('importing the bridge agent does not run its command entry', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(pathToFileURL(agent).href)})`,
  ], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

async function observeUntil(root, request, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await exchange(root, frame(request, 'observe'));
    if (predicate(value.body)) return value.body;
    if (['failed', 'indeterminate'].includes(value.body.state)) {
      throw new Error(`observation became ${value.body.state}: ${value.body.reason ?? 'no reason was reported'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('observation timeout');
}

test('health reports the exact protocol feature surface and target binding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-agent-'));
  try {
    const response = await exchange(root, frame('1'.repeat(32), 'health'));
    assert.equal(response.ok, true);
    assert.equal(response.body.version, '1.0.0');
    assert.deepEqual([...response.body.features].sort(), ['cancel', 'execute', 'get', 'health', 'observe', 'put']);
    const forged = { ...frame('2'.repeat(32), 'health'), target: 'env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    const rejected = await exchange(root, forged);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /target does not match/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('put/get roundtrip is digest-bound and traversal is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-transfer-'));
  try {
    const bytes = Buffer.from('payload');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const put = await exchange(root, frame('3'.repeat(32), 'put', { destination: { class: 'input', path: 'a/b.bin' }, offset: 0, data: bytes.toString('base64'), eof: true, digest }));
    assert.equal(put.ok, true);
    assert.equal(put.body.digest, digest);
    const get = await exchange(root, frame('4'.repeat(32), 'get', { source: { class: 'work', path: 'missing.bin' }, offset: 0, limit: 1024 }));
    assert.equal(get.ok, false);
    const bad = await exchange(root, frame('5'.repeat(32), 'put', { destination: { class: 'input', path: '../escape' }, offset: 0, data: '', eof: true, digest: createHash('sha256').update('').digest('hex') }));
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /invalid segment/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('put accepts an exact final-chunk replay without rewriting the destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-replay-'));
  try {
    const bytes = Buffer.from('replay');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const request = '6'.repeat(32);
    const body = { destination: { class: 'input', path: 'replay.bin' }, offset: 0, data: bytes.toString('base64'), eof: true, digest };
    assert.equal((await exchange(root, frame(request, 'put', body))).ok, true);
    assert.equal((await exchange(root, frame(request, 'put', body))).ok, true);
    assert.equal(await readFile(path.join(root, 'input', 'replay.bin'), 'utf8'), 'replay');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('execute is durable, asynchronous, and exact replay does not repeat side effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-exec-'));
  try {
    const request = '7'.repeat(32);
    const operation = {
      program: nodeProgram,
      arguments: ['-e', "const fs=require('fs'); const p='count.txt'; let n=0; try{n=+fs.readFileSync(p,'utf8')}catch{} fs.writeFileSync(p,String(n+1)); console.log('done')"],
      directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 5_000, maxOutputBytes: 4096,
    };
    const started = await exchange(root, frame(request, 'execute', operation));
    assert.equal(started.ok, true);
    assert.ok(['planned', 'running', 'completed'].includes(started.body.state));
    const completed = await observeUntil(root, request, (body) => body.state === 'completed');
    assert.equal(Buffer.from(completed.result.stdout, 'base64').toString('utf8').trim(), 'done');
    const replay = await exchange(root, frame(request, 'execute', operation));
    assert.equal(replay.body.state, 'completed');
    assert.equal(await readFile(path.join(root, 'work', 'count.txt'), 'utf8'), '1');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('concurrent exact execute requests are fenced to one guest-side effect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-concurrent-'));
  try {
    const request = 'c'.repeat(32);
    const operation = {
      program: nodeProgram,
      arguments: ['-e', "const fs=require('fs'); const p='concurrent.txt'; let n=0; try{n=+fs.readFileSync(p,'utf8')}catch{} fs.writeFileSync(p,String(n+1)); setTimeout(()=>{},150)"],
      directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 5_000, maxOutputBytes: 4096,
    };
    const [left, right] = await Promise.all([exchange(root, frame(request, 'execute', operation)), exchange(root, frame(request, 'execute', operation))]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    await observeUntil(root, request, (body) => body.state === 'completed');
    assert.equal(await readFile(path.join(root, 'work', 'concurrent.txt'), 'utf8'), '1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('logical location arguments resolve only inside guest class roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-location-'));
  try {
    const bytes = Buffer.from('location-payload');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await exchange(root, frame('d'.repeat(32), 'put', { destination: { class: 'input', path: 'ports/source.txt' }, offset: 0, data: bytes.toString('base64'), eof: true, digest }));
    const request = 'e'.repeat(32);
    const operation = {
      program: nodeProgram,
      arguments: ['-e', "const fs=require('fs'); fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1]));", { class: 'input', path: 'ports/source.txt' }, { class: 'output', path: 'ports/result.txt' }],
      directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 5_000, maxOutputBytes: 4096,
    };
    await exchange(root, frame(request, 'execute', operation));
    const completed = await observeUntil(root, request, (body) => body.state === 'completed');
    assert.equal(completed.result.exitCode, 0);
    assert.equal(await readFile(path.join(root, 'output', 'ports', 'result.txt'), 'utf8'), 'location-payload');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('guest operations inherit only a minimal local runtime environment plus explicit values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-env-'));
  try {
    const request = '0'.repeat(32);
    const operation = {
      program: nodeProgram,
      arguments: ['-e', "process.stdout.write((process.env.DEVBRIDGE_GUEST_TARGET||'none')+'|'+(process.env.EXPLICIT_VALUE||'missing'))"],
      directory: { class: 'work', path: '.' }, environment: { EXPLICIT_VALUE: 'present' }, input: null, timeoutMs: 5_000, maxOutputBytes: 4096,
    };
    await exchange(root, frame(request, 'execute', operation));
    const completed = await observeUntil(root, request, (body) => body.state === 'completed');
    assert.equal(Buffer.from(completed.result.stdout, 'base64').toString('utf8'), 'none|present');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('same request identity cannot be reused for a changed operation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-change-'));
  try {
    const request = '8'.repeat(32);
    const base = { program: nodeProgram, arguments: ['-e', "console.log('a')"], directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 5_000, maxOutputBytes: 4096 };
    await exchange(root, frame(request, 'execute', base));
    await observeUntil(root, request, (body) => body.state === 'completed');
    const changed = await exchange(root, frame(request, 'execute', { ...base, arguments: ['-e', "console.log('b')"] }));
    assert.equal(changed.ok, false);
    assert.match(changed.error.message, /reused for a different operation/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation is request-bound and completion becomes observable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-cancel-'));
  try {
    const request = '9'.repeat(32);
    const operation = { program: nodeProgram, arguments: ['-e', 'setTimeout(()=>{}, 10000)'], directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 20_000, maxOutputBytes: 4096 };
    await exchange(root, frame(request, 'execute', operation));
    await observeUntil(root, request, (body) => body.state === 'running');
    const other = await exchange(root, frame('a'.repeat(32), 'cancel', { reason: 'abort' }));
    assert.equal(other.body.state, 'absent');
    const cancelled = await exchange(root, frame(request, 'cancel', { reason: 'abort' }));
    assert.equal(cancelled.ok, true);
    const completed = await observeUntil(root, request, (body) => body.state === 'completed', 8_000);
    assert.equal(completed.result.aborted, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('guest-side timeout terminates the operation and records timedOut', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-timeout-'));
  try {
    const request = 'b'.repeat(32);
    const operation = { program: nodeProgram, arguments: ['-e', 'setTimeout(()=>{}, 10000)'], directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 1_000, maxOutputBytes: 4096 };
    await exchange(root, frame(request, 'execute', operation));
    const completed = await observeUntil(root, request, (body) => body.state === 'completed', 8_000);
    assert.equal(completed.result.timedOut, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed and unknown request fields fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-malformed-'));
  try {
    const invalid = await exchange(root, { ...frame('c'.repeat(32), 'health'), provider: 'foreign' });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error.message, /provider is not allowed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
