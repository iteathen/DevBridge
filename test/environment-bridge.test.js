import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EnvironmentBridge, EnvironmentBridgeError, EnvironmentBridgeIndeterminateError, ENVIRONMENT_BRIDGE_PROTOCOL } from '../src/runtime/environment-bridge.js';

const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const result = (stdout = 'ok') => ({
  exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false,
  stdout: Buffer.from(stdout).toString('base64'), stderr: '', startedAt: '2026-08-20T00:00:00.000Z', finishedAt: '2026-08-20T00:00:01.000Z', lastOutputAt: null,
});
const response = (frame, body, extra = {}) => ({ protocol: ENVIRONMENT_BRIDGE_PROTOCOL, request: frame.request, target: frame.target, kind: frame.kind, ok: true, body, ...extra });

test('health requires compatible feature and major-version surface', async () => {
  const bridge = new EnvironmentBridge({ exchange: async (frame) => response(frame, { version: '1.2.3', features: ['get', 'put', 'cancel', 'observe', 'execute', 'health'] }) });
  const health = await bridge.health(target);
  assert.equal(health.ready, true);
  const old = new EnvironmentBridge({ exchange: async (frame) => response(frame, { version: '2.0.0', features: ['get', 'put', 'cancel', 'observe', 'execute', 'health'] }) });
  assert.equal((await old.health(target)).ready, false);
});

test('forged response identity fails closed', async () => {
  const bridge = new EnvironmentBridge({ exchange: async (frame) => ({ ...response(frame, { version: '1.0.0', features: ['get', 'put', 'cancel', 'observe', 'execute', 'health'] }), target: 'env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }) });
  await assert.rejects(() => bridge.health(target), /identity does not match/u);
});

test('unknown response fields and oversized frames fail closed', async () => {
  const bridge = new EnvironmentBridge({ exchange: async (frame) => ({ ...response(frame, { version: '1.0.0', features: [] }), forged: true }) });
  await assert.rejects(() => bridge.health(target), /forged is not allowed/u);
  const huge = new EnvironmentBridge({ exchange: async (frame) => response(frame, { version: '1.0.0', features: ['x'.repeat(25 * 1024 * 1024)] }) });
  await assert.rejects(() => huge.health(target), /hard frame limit/u);
});

test('execution start is observed to completion with bounded normalized output', async () => {
  let observed = 0;
  const bridge = new EnvironmentBridge({ exchange: async (frame) => {
    if (frame.kind === 'execute') return response(frame, { state: 'planned', result: null, reason: null });
    if (frame.kind === 'observe') {
      observed += 1;
      return response(frame, observed === 1 ? { state: 'running', result: null, reason: null } : { state: 'completed', result: result('hello'), reason: null });
    }
    throw new Error('unexpected');
  } });
  const outcome = await bridge.execute(target, { program: 'node', arguments: [], directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 2_000, maxOutputBytes: 4096 }, { pollIntervalMs: 100 });
  assert.equal(outcome.completion, 'observed');
  assert.equal(outcome.result.stdout, 'hello');
  assert.equal(observed, 2);
});

test('interrupted execution start observes before repeating the exact request', async () => {
  let starts = 0;
  let observes = 0;
  const bridge = new EnvironmentBridge({ exchange: async (frame) => {
    if (frame.kind === 'execute') {
      starts += 1;
      if (starts === 1) throw new Error('transport lost after effect');
      return response(frame, { state: 'planned', result: null, reason: null });
    }
    if (frame.kind === 'observe') {
      observes += 1;
      if (observes === 1) return response(frame, { state: 'absent', result: null, reason: null });
      return response(frame, { state: 'completed', result: result('recovered'), reason: null });
    }
    throw new Error('unexpected');
  } });
  const outcome = await bridge.execute(target, { program: 'node', arguments: [], directory: { class: 'work', path: '.' }, environment: {}, timeoutMs: 2_000, maxOutputBytes: 4096 }, { request: '1'.repeat(32), pollIntervalMs: 100 });
  assert.equal(outcome.result.stdout, 'recovered');
  assert.equal(starts, 2);
  assert.ok(observes >= 2);
});

test('a durable planned request is observed then safely re-presented with the exact identity to recover pre-effect monitor loss', async () => {
  let starts = 0;
  let observes = 0;
  let first = null;
  const bridge = new EnvironmentBridge({ exchange: async (frame) => {
    if (frame.kind === 'execute') {
      starts += 1;
      if (!first) first = structuredClone(frame);
      else assert.deepEqual(frame, first);
      return response(frame, starts === 1 ? { state: 'planned', result: null, reason: null } : { state: 'completed', result: result('resumed'), reason: null });
    }
    if (frame.kind === 'observe') {
      observes += 1;
      return response(frame, { state: 'planned', result: null, reason: null });
    }
    throw new Error('unexpected');
  } });
  const outcome = await bridge.execute(target, { program: 'node', arguments: [], directory: { class: 'work', path: '.' }, environment: {}, timeoutMs: 2_000, maxOutputBytes: 4096 }, { request: 'f'.repeat(32), pollIntervalMs: 100 });
  assert.equal(outcome.result.stdout, 'resumed');
  assert.equal(starts, 2);
  assert.equal(observes, 1);
});

test('unreconcilable start returns an indeterminate error instead of blind replay', async () => {
  let starts = 0;
  const bridge = new EnvironmentBridge({ exchange: async (frame) => {
    if (frame.kind === 'execute') { starts += 1; throw new Error('lost'); }
    if (frame.kind === 'observe') throw new Error('also lost');
    throw new Error('unexpected');
  } });
  await assert.rejects(() => bridge.execute(target, { program: 'node', arguments: [], directory: { class: 'work', path: '.' }, environment: {}, timeoutMs: 1_000, maxOutputBytes: 4096 }, { request: '2'.repeat(32) }), EnvironmentBridgeIndeterminateError);
  assert.equal(starts, 1);
});

test('abort cancels the exact request and returns observed completion when available', async () => {
  const controller = new AbortController();
  let cancelled = null;
  let observeCount = 0;
  const bridge = new EnvironmentBridge({ exchange: async (frame) => {
    if (frame.kind === 'execute') return response(frame, { state: 'running', result: null, reason: null });
    if (frame.kind === 'cancel') { cancelled = frame.request; return response(frame, { state: 'running' }); }
    if (frame.kind === 'observe') {
      observeCount += 1;
      if (observeCount < 2) return response(frame, { state: 'running', result: null, reason: null });
      return response(frame, { state: 'completed', result: { ...result(''), aborted: true }, reason: null });
    }
    throw new Error('unexpected');
  } });
  setTimeout(() => controller.abort(), 50);
  const outcome = await bridge.execute(target, { program: 'node', arguments: [], directory: { class: 'work', path: '.' }, environment: {}, timeoutMs: 5_000, maxOutputBytes: 4096 }, { request: '3'.repeat(32), signal: controller.signal, pollIntervalMs: 100 });
  assert.equal(cancelled, '3'.repeat(32));
  assert.equal(outcome.completion, 'observed');
  assert.equal(outcome.result.aborted, true);
});

test('pre-existing cancellation returns an aborted result without crossing the exchange port', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const bridge = new EnvironmentBridge({ exchange: async () => { calls += 1; throw new Error('must not exchange'); } });
  const outcome = await bridge.execute(target, {
    program: 'node', arguments: [], directory: { class: 'work', path: '.' }, environment: {}, timeoutMs: 2_000, maxOutputBytes: 4096,
  }, { request: 'e'.repeat(32), signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(outcome.completion, 'observed');
  assert.equal(outcome.result.exitCode, null);
  assert.equal(outcome.result.aborted, true);
});

test('logical path and executable validation rejects path authority before exchange', async () => {
  let calls = 0;
  const bridge = new EnvironmentBridge({ exchange: async () => { calls += 1; } });
  await assert.rejects(() => bridge.execute(target, { program: '/bin/sh', arguments: [], directory: { class: 'work', path: '.' }, environment: {}, timeoutMs: 1_000, maxOutputBytes: 4096 }), /logical executable/u);
  await assert.rejects(() => bridge.execute(target, { program: 'node', arguments: [], directory: { class: 'work', path: '../host' }, environment: {}, timeoutMs: 1_000, maxOutputBytes: 4096 }), /invalid segment/u);
  assert.equal(calls, 0);
});


test('logical location arguments stay logical on the wire and request framing is bounded before exchange', async () => {
  let seen = null;
  const bridge = new EnvironmentBridge({ exchange: async (frame) => {
    seen = frame;
    if (frame.kind === 'execute') return response(frame, { state: 'completed', result: result('ok'), reason: null });
    throw new Error('unexpected');
  } });
  const outcome = await bridge.execute(target, {
    program: 'node',
    arguments: ['literal', { class: 'input', path: 'ports/source.bin' }, { class: 'output', path: 'ports/result.bin' }],
    directory: { class: 'work', path: '.' }, environment: {}, input: null, timeoutMs: 1_000, maxOutputBytes: 4096,
  });
  assert.equal(outcome.result.stdout, 'ok');
  assert.deepEqual(seen.body.arguments[1], { class: 'input', path: 'ports/source.bin' });
  assert.deepEqual(seen.body.arguments[2], { class: 'output', path: 'ports/result.bin' });

  const oversized = new EnvironmentBridge({ exchange: async () => { throw new Error('must not exchange'); } });
  await assert.rejects(() => oversized.execute(target, {
    program: 'node', arguments: ['x'.repeat(43 * 1024)], directory: { class: 'work', path: '.' }, environment: {}, input: 'y'.repeat(2 * 1024), timeoutMs: 1_000, maxOutputBytes: 4096,
  }), /common transport frame limit/u);
});

test('put streams only capability bytes and verifies final digest', async () => {
  const payload = Buffer.from('transfer payload');
  const expected = createHash('sha256').update(payload).digest('hex');
  let calls = 0;
  const bridge = new EnvironmentBridge({ exchange: async (frame) => {
    calls += 1;
    assert.equal(frame.kind, 'put');
    assert.deepEqual(frame.body.destination, { class: 'input', path: 'source.bin' });
    const bytes = Buffer.from(frame.body.data, 'base64');
    return response(frame, { nextOffset: frame.body.offset + bytes.length, complete: frame.body.eof, digest: frame.body.eof ? frame.body.digest : null });
  } });
  let read = false;
  const source = { async read() { if (read) return { data: Buffer.alloc(0), eof: true }; read = true; return { data: payload, eof: true }; } };
  const outcome = await bridge.put(target, source, { class: 'input', path: 'source.bin' });
  assert.equal(outcome.digest, expected);
  assert.equal(calls, 1);
});

test('put retries the exact chunk after interrupted exchange', async () => {
  const payload = Buffer.from('abc');
  let attempts = 0;
  let firstFrame = null;
  const bridge = new EnvironmentBridge({ exchange: async (frame) => {
    attempts += 1;
    if (!firstFrame) firstFrame = structuredClone(frame);
    else assert.deepEqual(frame, firstFrame);
    if (attempts === 1) throw new Error('lost response');
    return response(frame, { nextOffset: 3, complete: true, digest: frame.body.digest });
  } });
  const source = { async read() { return { data: payload, eof: true }; } };
  await bridge.put(target, source, { class: 'input', path: 'a.bin' }, { request: '4'.repeat(32) });
  assert.equal(attempts, 2);
});

test('get validates the complete digest before exposing any bytes to the sink', async () => {
  const payload = Buffer.from('guest result');
  const digest = createHash('sha256').update(payload).digest('hex');
  let writes = 0;
  const sink = { async write(entry) { writes += 1; assert.deepEqual(entry.data, payload); assert.equal(entry.digest, digest); } };
  const bridge = new EnvironmentBridge({ exchange: async (frame) => response(frame, { offset: frame.body.offset, data: payload.toString('base64'), eof: true, digest }) });
  await bridge.get(target, { class: 'output', path: 'result.bin' }, sink);
  assert.equal(writes, 1);

  let forgedWrites = 0;
  const forged = new EnvironmentBridge({ exchange: async (frame) => response(frame, { offset: frame.body.offset, data: payload.toString('base64'), eof: true, digest: '0'.repeat(64) }) });
  await assert.rejects(() => forged.get(target, { class: 'output', path: 'result.bin' }, { async write() { forgedWrites += 1; } }), /digest is inconsistent/u);
  assert.equal(forgedWrites, 0);
});

test('get rejects stalled and oversized protocol responses', async () => {
  const stalled = new EnvironmentBridge({ exchange: async (frame) => response(frame, { offset: frame.body.offset, data: '', eof: false, digest: null }) });
  await assert.rejects(() => stalled.get(target, { class: 'output', path: 'x' }, { async write() {} }), /made no progress/u);
  assert.throws(() => new EnvironmentBridge({ exchange: null }), /exchange must be a function/u);
});
