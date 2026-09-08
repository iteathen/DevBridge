import test from 'node:test';
import assert from 'node:assert/strict';
import { openJsonCommandChannel } from '../src/runtime/command-channel.js';

const echo = `const readline = require('node:readline'); let count = 0; readline.createInterface({input:process.stdin}).on('line', line => process.stdout.write(JSON.stringify({value:JSON.parse(line),count:++count,pid:process.pid})+'\\n'));`;
const channel = (code = echo, options = {}) => openJsonCommandChannel({ executable: process.execPath, arguments: ['-e', code], ...options });

test('one bounded process serves sequential requests without replay or reconnect', async t => {
  const current = channel(); t.after(() => current.close());
  const first = await current.exchange({ subject: 'a', bytes: '☃' });
  const second = await current.exchange({ subject: 'b' });
  assert.deepEqual(first.value, { subject: 'a', bytes: '☃' });
  assert.equal(first.pid, second.pid);
  assert.equal(second.count, 2);
  current.close();
  await assert.rejects(current.exchange({}), { code: 'CLOSED' });
});

test('request bounds and overlapping callers fail without sending another effect', async t => {
  const current = channel(`setTimeout(() => process.stdout.write('{}\\n'), 200); process.stdin.resume();`, { inputLimit: 32 });
  t.after(() => current.close());
  await assert.rejects(current.exchange({ data: 'a'.repeat(33) }), /exceeded its bound/);
  const first = current.exchange({});
  await assert.rejects(current.exchange({}), /active request/);
  assert.deepEqual(await first, {});
});

test('process loss and malformed/oversized responses close the channel and preserve bounded evidence', async t => {
  for (const [code, expected] of [
    [`process.stdin.once('data', () => { process.stderr.write('native failure'); process.exit(7); });`, 'DISCONNECTED'],
    [`process.stdin.once('data', () => process.stdout.write('{}\\n{}\\n'));`, 'PROTOCOL'],
    [`process.stdin.once('data', () => process.stdout.write('x'.repeat(128)));`, 'OUTPUT_LIMIT'],
  ]) {
    const current = channel(code, { outputLimit: 64 }); t.after(() => current.close());
    await assert.rejects(current.exchange({}), error => {
      assert.equal(error.code, expected);
      if (expected === 'DISCONNECTED') { assert.equal(error.native.exitCode, 7); assert.equal(error.native.stderr, 'native failure'); }
      if (expected === 'OUTPUT_LIMIT') assert.equal(error.native.outputTruncated, true);
      return true;
    });
    await assert.rejects(current.exchange({}), { code: expected });
  }
});

test('deadline and owner cancellation terminate pending work without retry', async t => {
  const stalled = `process.stdin.resume();`;
  const timed = channel(stalled, { timeoutMs: 100 }); t.after(() => timed.close());
  await assert.rejects(timed.exchange({}), error => error.code === 'TIMEOUT' && error.native.timedOut);
  const controller = new AbortController();
  const cancelled = channel(stalled, { signal: controller.signal }); t.after(() => cancelled.close());
  const pending = cancelled.exchange({});
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ABORTED' && error.native.aborted);
});
