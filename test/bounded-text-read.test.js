import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedText } from '../src/runtime/bounded-text-read.js';

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

test('bounded text read recovers from transient access denial on its fixed schedule', async () => {
  const waits = [];
  let reads = 0;
  const text = await readBoundedText('local-record', {
    async read(filePath, encoding) {
      reads += 1;
      assert.equal(filePath, 'local-record');
      assert.equal(encoding, 'utf8');
      if (reads < 3) throw codedError('EPERM');
      return ' exact bytes\r\n';
    },
    async wait(delayMs) { waits.push(delayMs); },
  });

  assert.equal(text, ' exact bytes\r\n');
  assert.equal(reads, 3);
  assert.deepEqual(waits, [5, 10]);
});

test('bounded text read rethrows the exact final transient error after exhaustion', async () => {
  const errors = Array.from({ length: 6 }, () => codedError('EPERM'));
  const waits = [];
  let reads = 0;
  await assert.rejects(() => readBoundedText('local-record', {
    async read() { const error = errors[reads]; reads += 1; throw error; },
    async wait(delayMs) { waits.push(delayMs); },
  }), (error) => error === errors[5]);

  assert.equal(reads, 6);
  assert.deepEqual(waits, [5, 10, 20, 40, 80]);
});

for (const code of ['ENOENT', 'EACCES', 'EBUSY']) {
  test(`bounded text read does not reinterpret ${code}`, async () => {
    const expected = codedError(code);
    let reads = 0;
    let waits = 0;
    await assert.rejects(() => readBoundedText('local-record', {
      async read() { reads += 1; throw expected; },
      async wait() { waits += 1; },
    }), (error) => error === expected);
    assert.equal(reads, 1);
    assert.equal(waits, 0);
  });
}

test('bounded text read leaves malformed content to the owning parser', async () => {
  assert.equal(await readBoundedText('local-record', {
    async read() { return '{not-json'; },
    async wait() { throw new Error('wait must not be called'); },
  }), '{not-json');
});

test('bounded text read rejects malformed local ports without filesystem effects', async () => {
  await assert.rejects(() => readBoundedText('', {}), /text source path is invalid/u);
  await assert.rejects(() => readBoundedText('local-record', { read: null }), /text read port is invalid/u);
  await assert.rejects(() => readBoundedText('local-record', { wait: null }), /wait port is invalid/u);
  await assert.rejects(() => readBoundedText('local-record', { read: async () => Buffer.from('bytes') }), /non-text value/u);
});
