import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedProcessFailureEvidence,
} from '../src/bootstrap/repository-preflight.mjs';

test('long TAP output retains the first failing subject, assertion, and terminal summary', () => {
  const before = Array.from({ length: 80 }, (_, index) => `ok ${index + 1} - earlier passing test with padded output ${'a'.repeat(40)}`).join('\n');
  const failure = [
    'not ok 81 - exact failing subject',
    '  ---',
    "  error: 'expected durable evidence'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
  ].join('\n');
  const after = Array.from({ length: 80 }, (_, index) => `ok ${index + 82} - later passing test with padded output ${'b'.repeat(40)}`).join('\n');
  const summary = ['1..161', '# tests 161', '# pass 160', '# fail 1'].join('\n');
  const value = boundedProcessFailureEvidence({ status: 1, stdout: `${before}\n${failure}\n${after}\n${summary}`, stderr: '' }, 1200);
  assert.match(value, /not ok 81 - exact failing subject/u);
  assert.match(value, /expected durable evidence/u);
  assert.match(value, /# fail 1/u);
  assert.ok(value.length <= 1200);
});

test('stdout failure evidence is not discarded when stderr also contains data', () => {
  const value = boundedProcessFailureEvidence({
    status: 1,
    stderr: `warning before failure ${'w'.repeat(800)}`,
    stdout: `${'p'.repeat(1200)}\nnot ok 4 - retained stdout failure\n  error: retained assertion\n${'z'.repeat(1200)}\n# fail 1`,
  }, 900);
  assert.match(value, /retained stdout failure/u);
  assert.match(value, /retained assertion/u);
  assert.match(value, /# fail 1/u);
  assert.ok(value.length <= 900);
});

test('non-TAP errors retain their bounded error neighborhood and terminal evidence', () => {
  const value = boundedProcessFailureEvidence({
    status: 2,
    stdout: `${'x'.repeat(900)}\nError: compiler exploded\ncode: ERR_TOOL_FAILURE\n${'y'.repeat(900)}\nterminal cleanup failed`,
    stderr: '',
  }, 700);
  assert.match(value, /Error: compiler exploded/u);
  assert.match(value, /ERR_TOOL_FAILURE/u);
  assert.match(value, /terminal cleanup failed/u);
  assert.ok(value.length <= 700);
});

test('small evidence remains exact and invalid bounds are rejected', () => {
  assert.equal(boundedProcessFailureEvidence({ status: 1, stderr: 'small failure', stdout: '' }), '[stderr]\nsmall failure');
  assert.throws(() => boundedProcessFailureEvidence({ status: 1, stderr: 'failure' }, 255), /bound is invalid/u);
});
