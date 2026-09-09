import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyHyperVGuestFile, HyperVFileCopyError } from '../src/runtime/providers/hyperv-file-copy.js';

const location = { reference: 'owned-machine', proof: 'owned-proof' };
const success = (value) => ({ exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-copy-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, '.random-seed.json');
  const bytes = Buffer.from([0, 10, 13, 128, 255]);
  await writeFile(source, bytes);
  return { root, source, bytes };
}

for (const family of ['linux', 'windows']) {
  test(`${family} copy preserves exact destination and bytes without changing its source`, async (t) => {
    const { root, source, bytes } = await fixture(t);
    const destination = family === 'linux' ? '/guest/nested/seed.json' : 'C:\\guest\\nested\\seed.json';
    const guest = new Map();
    await copyHyperVGuestFile({
      family, location, source, destination,
      invoke: async (request) => {
        const native = JSON.parse(request.input);
        assert.equal(native.reference, location.reference);
        assert.equal(native.proof, location.proof);
        const resolved = family === 'linux' ? path.posix.join(native.destination, path.basename(native.source)) : native.destination;
        guest.set(resolved, await readFile(native.source));
        if (family === 'windows') assert.equal(native.source.toLowerCase(), (await realpath(source)).toLowerCase());
        return success({ delivered: true });
      },
    });
    assert.deepEqual(guest.get(destination), bytes);
    assert.equal(guest.size, 1);
    assert.deepEqual(await readFile(source), bytes);
    assert.deepEqual(await readdir(root), [path.basename(source)]);
  });
}

test('copy failures retain native facts and clean staging without implying a retry is safe', async (t) => {
  const { root, source } = await fixture(t);
  const cases = [
    { result: success({ delivered: false, failure: { code: 'service-not-ready', attempted: false, nativeCode: '0x00000001', message: 'no contact' } }), code: 'service-not-ready', retryable: true, effect: 'not-attempted' },
    { result: success({ delivered: false, failure: { code: 'ownership-mismatch', attempted: false, message: 'proof changed' } }), code: 'ownership-mismatch', retryable: false, effect: 'not-attempted' },
    { result: success({ delivered: false, failure: { code: 'invalid-argument', attempted: true, nativeCode: '0x80070057', category: 'InvalidArgument', message: 'invalid destination' } }), code: 'invalid-argument', retryable: false, effect: 'uncertain' },
    { result: { ...success(null), exitCode: null, timedOut: true, stderr: 'native deadline' }, code: 'copy-outcome-unknown', retryable: false, effect: 'uncertain' },
    { result: { ...success(null), aborted: true }, code: 'copy-outcome-unknown', retryable: false, effect: 'uncertain' },
    { result: { ...success({ delivered: true }), outputTruncated: true }, code: 'copy-outcome-unknown', retryable: false, effect: 'uncertain' },
    { result: { ...success(null), stdout: 'invalid JSON' }, code: 'copy-outcome-unknown', retryable: false, effect: 'uncertain' },
  ];
  for (const item of cases) {
    await assert.rejects(copyHyperVGuestFile({ family: 'linux', location, source, destination: '/seed.json', invoke: async () => item.result }), (error) => {
      assert.ok(error instanceof HyperVFileCopyError);
      assert.equal(error.code, item.code);
      assert.equal(error.retryable, item.retryable);
      assert.equal(error.effect, item.effect);
      assert.equal(error.evidence.exitCode, item.result.exitCode);
      assert.equal(error.evidence.timedOut, item.result.timedOut);
      return true;
    });
    assert.deepEqual(await readdir(root), [path.basename(source)]);
  }
});

test('invalid or unrepresentable destinations fail before invocation', async (t) => {
  const { source } = await fixture(t);
  for (const destination of ['relative', '/guest/../seed', '/guest/', '/guest/a:b', '/guest/CON', '/guest/a\\b']) {
    await assert.rejects(copyHyperVGuestFile({ family: 'linux', location, source, destination, invoke: async () => assert.fail('must not invoke') }), TypeError);
  }
});
