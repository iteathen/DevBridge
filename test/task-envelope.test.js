import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskEnvelope } from '../src/github/task-envelope.js';
import { ProtocolError } from '../src/errors.js';

function body(object) {
  return `\`\`\`patch-poller-task\n${JSON.stringify(object)}\n\`\`\``;
}

test('parses a bounded standalone task envelope and produces an exact-byte revision', () => {
  const task = {
    protocol: 'patch-poller/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Fix the thing.',
    requestedCapabilities: ['project.write'],
    preferredTool: 'codex'
  };
  const exact = body(task);
  const a = parseTaskEnvelope(exact);
  const b = parseTaskEnvelope(exact);
  assert.equal(a.envelope.target.repository, 'iteathen/example');
  assert.equal(a.revision, b.revision);
  assert.match(a.revision, /^[0-9a-f]{64}$/u);
  assert.notEqual(parseTaskEnvelope(`${exact}\n`).revision, a.revision);
});

test('preserves bounded context handoff text as revision-bound task data', () => {
  const task = {
    protocol: 'patch-poller/task-v1',
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
    protocol: 'patch-poller/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Relay context.'
  };
  assert.throws(() => parseTaskEnvelope(body({ ...base, context: { handoff: { x: 1 } } })), /context\.handoff must be a string/u);
  assert.throws(() => parseTaskEnvelope(body({ ...base, context: { handoff: 'x'.repeat(16_001) } })), /handoff limit/u);
});

test('rejects remote command authority', () => {
  assert.throws(() => parseTaskEnvelope(body({
    protocol: 'patch-poller/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Do work.',
    command: 'rm -rf /'
  })), ProtocolError);
});

test('surrounding discussion, quoted authority, and multiple envelopes are rejected', () => {
  const one = body({ protocol: 'patch-poller/task-v1', target: { repository: 'iteathen/example' }, instructions: 'A' });
  assert.throws(() => parseTaskEnvelope(`Task description\n\n${one}`), /standalone/u);
  assert.throws(() => parseTaskEnvelope(`> ${one.replaceAll('\n', '\n> ')}`), /standalone/u);
  assert.throws(() => parseTaskEnvelope(`${one}\n${one}`), /standalone/u);
});
