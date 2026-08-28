import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
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

async function seedPlannedOperation(root, request, body) {
  const operations = path.join(root, '.operations');
  await mkdir(operations, { recursive: true });
  const record = {
    protocol: 'devbridge/environment-bridge-operation-v1',
    request,
    target,
    digest: createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex'),
    body,
    state: 'planned',
    createdAt: new Date().toISOString(),
    monitorPid: null,
    childPid: null,
    result: null,
    reason: null,
  };
  await writeFile(path.join(operations, `${request}.json`), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
  return path.join(operations, `${request}.monitor.json`);
}

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
    for (let round = 0; round < 6; round += 1) {
      const request = (12 + round).toString(16).padStart(32, '0');
      const result = `concurrent-${round}.txt`;
      const operation = {
        program: nodeProgram,
        arguments: ['-e', `const fs=require('fs'); const p=${JSON.stringify(result)}; let n=0; try{n=+fs.readFileSync(p,'utf8')}catch{} fs.writeFileSync(p,String(n+1)); setTimeout(()=>{},150)`],
        directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 5_000, maxOutputBytes: 4096,
      };
      const responses = await Promise.all(Array.from({ length: 4 }, () => exchange(root, frame(request, 'execute', operation))));
      for (const response of responses) assert.equal(response.ok, true);
      await observeUntil(root, request, (body) => body.state === 'completed');
      assert.equal(await readFile(path.join(root, 'work', result), 'utf8'), '1');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent exact execute observes a claim whose publication is still completing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-claim-publish-'));
  let claimHandle;
  try {
    const request = '1'.repeat(32);
    const operation = {
      program: nodeProgram,
      arguments: ['-e', "require('fs').writeFileSync('published.txt','1')"],
      directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 5_000, maxOutputBytes: 4096,
    };
    const claimFile = await seedPlannedOperation(root, request, operation);
    claimHandle = await open(claimFile, 'wx');
    await claimHandle.writeFile('{', 'utf8');
    const pending = exchange(root, frame(request, 'execute', operation));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await claimHandle.writeFile(`${JSON.stringify({ token: 'claim-publication-token', state: 'starting', pid: process.pid, createdAt: Date.now() }).slice(1)}\n`, 'utf8');
    await claimHandle.close();
    claimHandle = null;
    const observed = await pending;
    assert.equal(observed.ok, true);
    assert.equal(observed.body.state, 'planned');

    await rm(claimFile);
    assert.equal((await exchange(root, frame(request, 'execute', operation))).ok, true);
    await observeUntil(root, request, (body) => body.state === 'completed');
    assert.equal(await readFile(path.join(root, 'work', 'published.txt'), 'utf8'), '1');
  } finally {
    try { await claimHandle?.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test('a claim disappearing during publication observation returns to exclusive acquisition', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-claim-disappear-'));
  let claimHandle;
  try {
    const request = '2'.repeat(32);
    const operation = {
      program: nodeProgram,
      arguments: ['-e', "require('fs').writeFileSync('reacquired.txt','1')"],
      directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 5_000, maxOutputBytes: 4096,
    };
    const claimFile = await seedPlannedOperation(root, request, operation);
    claimHandle = await open(claimFile, 'wx');
    await claimHandle.writeFile('{', 'utf8');
    const pending = exchange(root, frame(request, 'execute', operation));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await claimHandle.close();
    claimHandle = null;
    await rm(claimFile);

    const reacquired = await pending;
    assert.equal(reacquired.ok, true);
    await observeUntil(root, request, (body) => body.state === 'completed');
    assert.equal(await readFile(path.join(root, 'work', 'reacquired.txt'), 'utf8'), '1');
  } finally {
    try { await claimHandle?.close(); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test('a permanently malformed monitor claim fails closed after bounded observation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-bridge-claim-malformed-'));
  try {
    const request = '3'.repeat(32);
    const operation = {
      program: nodeProgram,
      arguments: ['-e', "require('fs').writeFileSync('forbidden.txt','1')"],
      directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 5_000, maxOutputBytes: 4096,
    };
    const claimFile = await seedPlannedOperation(root, request, operation);
    await writeFile(claimFile, '{', { encoding: 'utf8', flag: 'wx' });
    const startedAt = Date.now();
    const rejected = await exchange(root, frame(request, 'execute', operation));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'operation-failed');
    assert.ok(Date.now() - startedAt < 2_000);
    await assert.rejects(readFile(path.join(root, 'work', 'forbidden.txt'), 'utf8'), { code: 'ENOENT' });
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
