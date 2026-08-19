import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskEnvelope } from '../src/github/task-envelope.js';
import { contentSha256 } from '../src/github/content-provenance.js';
import { ProtocolError } from '../src/errors.js';

function body(object) {
  return `Task description\n\n\`\`\`devbridge-task\n${JSON.stringify(object)}\n\`\`\``;
}

test('parses a bounded task envelope and produces a stable exact-body-bound revision', () => {
  const task = {
    protocol: 'devbridge/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Fix the thing.',
    requestedCapabilities: ['project.write'],
    preferredTool: 'codex'
  };
  const raw = body(task);
  const a = parseTaskEnvelope(raw);
  const b = parseTaskEnvelope(raw);
  assert.equal(a.envelope.target.repository, 'iteathen/example');
  assert.equal(a.revision, b.revision);
  assert.equal(a.contentSha256, contentSha256(raw));
  assert.match(a.revision, /^[0-9a-f]{64}$/);

  const surroundingBodyChanged = raw.replace('Task description', 'Task description changed');
  const changed = parseTaskEnvelope(surroundingBodyChanged);
  assert.deepEqual(changed.envelope, a.envelope);
  assert.notEqual(changed.contentSha256, a.contentSha256);
  assert.notEqual(changed.revision, a.revision);
});

test('preserves bounded context handoff text as revision-bound task data', () => {
  const task = {
    protocol: 'devbridge/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Relay context.',
    context: { handoff: 'nonce=abc\npayload=exact\n' }
  };
  const parsed = parseTaskEnvelope(body(task));
  assert.equal(parsed.envelope.context.handoff, task.context.handoff);
  const changed = structuredClone(task);
  changed.context.handoff = 'nonce=def\npayload=exact\n';
  assert.notEqual(parseTaskEnvelope(body(changed)).revision, parsed.revision);
});

test('rejects oversized or non-string handoff data', () => {
  const base = {
    protocol: 'devbridge/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Relay context.'
  };
  assert.throws(() => parseTaskEnvelope(body({ ...base, context: { handoff: { x: 1 } } })), /context\.handoff must be a string/u);
  assert.throws(() => parseTaskEnvelope(body({ ...base, context: { handoff: 'x'.repeat(16_001) } })), /handoff limit/u);
});

test('rejects remote command authority', () => {
  assert.throws(() => parseTaskEnvelope(body({
    protocol: 'devbridge/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Do work.',
    command: 'rm -rf /'
  })), ProtocolError);
});

test('requires exactly one unquoted machine envelope', () => {
  const one = body({ protocol: 'devbridge/task-v1', target: { repository: 'iteathen/example' }, instructions: 'A' });
  assert.throws(() => parseTaskEnvelope(`${one}\n${one}`), /exactly one/);

  const quoted = one.split('\n').map((line) => `> ${line}`).join('\n');
  assert.throws(() => parseTaskEnvelope(quoted), /exactly one/);
});
