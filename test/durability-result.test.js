import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResultJsonText } from '../src/runtime/result-json.js';
import { parseToolResult } from '../src/run/result-envelope.js';

const complete = {
  protocol: 'devbridge/result-v1',
  status: 'complete',
  summary: 'done',
  progress: [],
  tests: [],
  nextStep: null,
  blocker: null
};

test('accepts one unambiguous Markdown json fence as presentation-only result formatting', () => {
  const text = '\uFEFF```json\r\n{"protocol":"devbridge/result-v1","status":"complete","summary":"ok"}\r\n```\r\n';
  const parsed = parseResultJsonText(text);
  assert.equal(parsed.protocol, 'devbridge/result-v1');
  assert.equal(parsed.status, 'complete');
  assert.equal(parsed.summary, 'ok');
});

test('does not guess through prose or multiple fenced payloads', () => {
  assert.throws(
    () => parseResultJsonText('note\n```json\n{"protocol":"devbridge/result-v1"}\n```'),
    SyntaxError
  );
  assert.throws(
    () => parseResultJsonText('```json\n{"a":1}\n```\n```json\n{"a":2}\n```'),
    SyntaxError
  );
});

test('preserves a conservative structured result when the wrapper later exits nonzero', () => {
  const result = parseToolResult({
    protocol: 'devbridge/result-v1',
    status: 'blocked',
    summary: 'compiler unavailable',
    blocker: 'no compiler',
    progress: [],
    tests: []
  }, {
    exitCode: 1,
    stderr: 'ERROR: Selected model is at capacity. Please try a different model.'
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blocker, 'no compiler');
  assert.equal(result.processExitMismatch, true);
  assert.equal(result.processExitCode, 1);
  assert.match(result.progress.at(-1), /preserved the result/u);
});

test('reconciles a structured completion through normal candidate verification despite wrapper exit mismatch', () => {
  const result = parseToolResult(complete, { exitCode: 1, stderr: 'wrapper failed after result' });
  assert.equal(result.status, 'complete');
  assert.equal(result.processExitMismatch, true);
  assert.equal(result.inferred, false);
});

test('classifies the observed model-capacity failure as bounded continuation when no result exists', () => {
  const result = parseToolResult(null, {
    exitCode: 1,
    stderr: 'ERROR: Selected model is at capacity. Please try a different model.'
  });
  assert.equal(result.status, 'continue');
  assert.equal(result.retryable, true);
  assert.equal(result.failureClassification, 'TRANSIENT');
  assert.match(result.summary, /transient model-capacity/u);
});

test('keeps unrelated nonzero tool exits terminal', () => {
  const result = parseToolResult(null, { exitCode: 2, stderr: 'ordinary tool failure' });
  assert.equal(result.status, 'failed');
  assert.equal(result.blocker, 'tool-exit');
});
