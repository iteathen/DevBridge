import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecisionEnvelope } from '../src/github/decision-envelope.js';
import { contentSha256 } from '../src/github/content-provenance.js';

const taskRevision = 'a'.repeat(64);
const subjectDigest = 'b'.repeat(64);
const checkpointId = 'checkpoint-0123456789abcdef0123456789abcdef';

function block(value) {
  return `\`\`\`devbridge-decision\n${JSON.stringify(value)}\n\`\`\``;
}

function decision(overrides = {}) {
  return {
    protocol: 'devbridge/decision-v1',
    runId: 'run-1',
    taskRevision,
    checkpointId,
    subjectDigest,
    action: 'approve',
    ...overrides,
  };
}

test('parses an exact decision and binds its complete comment bytes', () => {
  const raw = block(decision());
  const parsed = parseDecisionEnvelope(raw);
  assert.equal(parsed.action, 'approve');
  assert.equal(parsed.contentSha256, contentSha256(raw));
  assert.notEqual(parseDecisionEnvelope(`${raw}\nreview note`).contentSha256, parsed.contentSha256);
});

test('rejects malformed run/task/checkpoint/subject bindings', () => {
  assert.throws(() => parseDecisionEnvelope(block(decision({ runId: '../bad' }))), /runId/u);
  assert.throws(() => parseDecisionEnvelope(block(decision({ taskRevision: 'bad' }))), /taskRevision/u);
  assert.throws(() => parseDecisionEnvelope(block(decision({ checkpointId: 'bad space' }))), /checkpointId/u);
  assert.throws(() => parseDecisionEnvelope(block(decision({ subjectDigest: 'bad' }))), /subjectDigest/u);
});

test('redirect requires bounded instructions and unknown authority-shaped fields are rejected', () => {
  assert.throws(() => parseDecisionEnvelope(block(decision({ action: 'redirect' }))), /requires instructions/u);
  assert.equal(parseDecisionEnvelope(block(decision({ action: 'redirect', instructions: 'Preserve the current public API.' }))).action, 'redirect');
  assert.throws(() => parseDecisionEnvelope(block(decision({ capability: 'filesystem.unrestricted' }))), /not supported/u);
});

test('quoted decision examples are ordinary discussion rather than authority', () => {
  const quoted = block(decision()).split('\n').map((line) => `> ${line}`).join('\n');
  assert.throws(() => parseDecisionEnvelope(quoted), /exactly one/u);
});
