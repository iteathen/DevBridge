import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolResult } from '../src/run/result-envelope.js';
import { ProtocolError } from '../src/errors.js';

test('accepts structured result envelopes and preserves continuation data', () => {
  const result = parseToolResult({ protocol: 'patch-poller/result-v1', status: 'continue', summary: 'first pass', progress: ['compiled'], tests: [{ name: 'unit', status: 'pass' }], nextStep: 'run integration' });
  assert.equal(result.status, 'continue');
  assert.equal(result.nextStep, 'run integration');
  assert.equal(result.inferred, false);
});

test('infers successful completion for legacy CLIs with clean exit and no result file', () => {
  const result = parseToolResult(null, { exitCode: 0, stdout: 'done' });
  assert.equal(result.status, 'complete');
  assert.equal(result.inferred, true);
});

test('rejects malformed structured output instead of silently accepting it', () => {
  assert.throws(() => parseToolResult(null, { resultParseError: 'bad json' }), ProtocolError);
});
