import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from '../src/security/redaction.js';

test('redacts configured values, common token forms, ANSI, and controls', () => {
  const input = '\u001b[31msecret-value github_pat_abcdefghijklmnopqrstuvwxyz123456\u0007';
  const output = redactText(input, ['secret-value']);
  assert.doesNotMatch(output, /secret-value/);
  assert.doesNotMatch(output, /github_pat_/);
  assert.doesNotMatch(output, /\u001b|\u0007/);
  assert.match(output, /\[REDACTED\]/);
});
