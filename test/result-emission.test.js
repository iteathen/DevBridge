import test from 'node:test';
import assert from 'node:assert/strict';
import { emitResult, extractResultEmission } from '../src/runtime/result-emission.js';

test('result emission round-trips one bounded JSON value without a filesystem endpoint', () => {
  let output = 'before\n';
  emitResult({ protocol: 'devbridge/result-v1', status: 'complete', summary: 'done' }, (value) => { output += value; });
  output += 'after\n';
  const extracted = extractResultEmission(output);
  assert.deepEqual(JSON.parse(extracted.text), { protocol: 'devbridge/result-v1', status: 'complete', summary: 'done' });
  assert.equal(extracted.output, 'before\nafter\n');
  assert.doesNotMatch(output, /[A-Za-z]:\\|\/tmp\/|result\.json/u);
});

test('result emission rejects ambiguous, malformed, and oversized records', () => {
  let record = '';
  emitResult({ status: 'complete' }, (value) => { record = value; });
  assert.throws(() => extractResultEmission(`${record}${record}`), /exactly one/u);
  assert.throws(() => extractResultEmission('\u001eRESULT_JSON not-base64!\n'), /valid record/u);
  assert.throws(() => emitResult({ value: 'x'.repeat(1_048_577) }, () => {}), /bounded JSON/u);
});
