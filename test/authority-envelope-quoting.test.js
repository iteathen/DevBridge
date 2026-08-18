import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskEnvelope } from '../src/github/task-envelope.js';
import { parseFeedbackEnvelope } from '../src/github/feedback-envelope.js';
import { parseDecisionEnvelope } from '../src/github/decision-envelope.js';

const revision = 'a'.repeat(64);
const subject = 'b'.repeat(64);
const task = `\`\`\`patch-poller-task\n${JSON.stringify({ protocol: 'patch-poller/task-v1', target: { repository: 'iteathen/repo' }, instructions: 'work' })}\n\`\`\``;
const feedback = `\`\`\`patch-poller-feedback\n${JSON.stringify({ protocol: 'patch-poller/feedback-v1', runId: 'run-1', taskRevision: revision, action: 'cancel' })}\n\`\`\``;
const decision = `\`\`\`patch-poller-decision\n${JSON.stringify({ protocol: 'patch-poller/decision-v1', runId: 'run-1', taskRevision: revision, checkpointId: 'gate-1', subjectDigest: subject, action: 'approve' })}\n\`\`\``;

function quote(value) { return value.split('\n').map((line) => `> ${line}`).join('\n'); }

test('quoted authority envelopes remain ordinary discussion', () => {
  assert.throws(() => parseTaskEnvelope(quote(task)), /unquoted/u);
  assert.throws(() => parseFeedbackEnvelope(quote(feedback)), /unquoted/u);
  assert.throws(() => parseDecisionEnvelope(quote(decision)), /unquoted/u);
});

test('an unquoted envelope remains authoritative even when a quoted copy is present for discussion', () => {
  assert.equal(parseTaskEnvelope(`${quote(task)}\n\n${task}`).envelope.instructions, 'work');
  assert.equal(parseFeedbackEnvelope(`${quote(feedback)}\n\n${feedback}`).action, 'cancel');
  assert.equal(parseDecisionEnvelope(`${quote(decision)}\n\n${decision}`).action, 'approve');
});
