import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskEnvelope } from '../src/github/task-envelope.js';
import { ProtocolError } from '../src/errors.js';

function body(object) {
  return `Task description\n\n\`\`\`patch-poller-task\n${JSON.stringify(object)}\n\`\`\``;
}

test('parses a bounded task envelope and produces a stable revision', () => {
  const task = {
    protocol: 'patch-poller/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Fix the thing.',
    requestedCapabilities: ['project.write'],
    preferredTool: 'codex'
  };
  const a = parseTaskEnvelope(body(task));
  const b = parseTaskEnvelope(body(task));
  assert.equal(a.envelope.target.repository, 'iteathen/example');
  assert.equal(a.revision, b.revision);
  assert.match(a.revision, /^[0-9a-f]{64}$/);
});

test('rejects remote command authority', () => {
  assert.throws(() => parseTaskEnvelope(body({
    protocol: 'patch-poller/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Do work.',
    command: 'rm -rf /'
  })), ProtocolError);
});

test('requires exactly one machine envelope', () => {
  const one = body({ protocol: 'patch-poller/task-v1', target: { repository: 'iteathen/example' }, instructions: 'A' });
  assert.throws(() => parseTaskEnvelope(`${one}\n${one}`), /exactly one/);
});
