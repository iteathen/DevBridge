import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runLocalProcess } from '../src/guest/local-process.mjs';

const nodeProgram = path.basename(process.execPath);

function input(directory, argumentsList, overrides = {}) {
  return {
    program: nodeProgram,
    arguments: argumentsList,
    directory,
    environment: {},
    input: null,
    timeoutMs: 5_000,
    maxOutputBytes: 4096,
    ...overrides,
  };
}

function ports(overrides = {}) {
  return {
    pulse: async () => {},
    readStop: async () => null,
    writeStop: async () => {},
    ...overrides,
  };
}

test('local process returns bounded exact output through neutral control ports', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-local-process-'));
  let pulses = 0;
  try {
    const result = await runLocalProcess(input(directory, ['-e', "process.stdout.write('ready'); process.stderr.write('note')"]), ports({ pulse: async () => { pulses += 1; } }));
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.from(result.stdout, 'base64').toString('utf8'), 'ready');
    assert.equal(Buffer.from(result.stderr, 'base64').toString('utf8'), 'note');
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.ok(pulses >= 1);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }); }
});

test('pre-observed stop returns without starting the process effect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-local-process-prestop-'));
  try {
    const result = await runLocalProcess(input(directory, ['-e', "require('fs').writeFileSync('forbidden.txt','1')"]), ports({ readStop: async () => 'abort' }));
    assert.equal(result.aborted, true);
    assert.equal(result.startedAt, null);
    await assert.rejects(readFile(path.join(directory, 'forbidden.txt')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local timeout publishes one stop and terminates only its live child', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-local-process-timeout-'));
  let stopped = null;
  let writes = 0;
  try {
    const result = await runLocalProcess(input(directory, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 1_000 }), ports({
      readStop: async () => stopped,
      writeStop: async (reason) => { stopped = reason; writes += 1; },
    }));
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    assert.equal(writes, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('observed abort is consumed by the owner while the child is still live', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-local-process-abort-'));
  let pulses = 0;
  try {
    const result = await runLocalProcess(input(directory, ['-e', 'setTimeout(()=>{}, 10000)']), ports({
      pulse: async () => { pulses += 1; },
      readStop: async () => pulses >= 2 ? 'abort' : null,
    }));
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('aggregate output is bounded across both streams', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-local-process-output-'));
  try {
    const result = await runLocalProcess(input(directory, ['-e', "process.stdout.write('a'.repeat(800)); process.stderr.write('b'.repeat(800))"], { maxOutputBytes: 1024 }), ports());
    assert.equal(Buffer.from(result.stdout, 'base64').length + Buffer.from(result.stderr, 'base64').length, 1024);
    assert.equal(result.outputTruncated, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pulse failure terminates the owned child and fails closed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-local-process-pulse-'));
  let pulses = 0;
  try {
    await assert.rejects(() => runLocalProcess(input(directory, ['-e', 'setTimeout(()=>{}, 10000)']), ports({
      pulse: async () => {
        pulses += 1;
        if (pulses >= 2) throw new Error('pulse unavailable');
      },
    })), /activity could not be maintained/u);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }); }
});

test('local process rejects widened input and malformed stop observations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-local-process-invalid-'));
  try {
    await assert.rejects(() => runLocalProcess({ ...input(directory, ['-e', '']), request: 'foreign' }, ports()), /request is not allowed/u);
    await assert.rejects(() => runLocalProcess(input(directory, ['-e', '']), ports({ readStop: async () => 'foreign' })), /stop observation is invalid/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
