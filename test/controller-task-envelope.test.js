import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskEnvelope } from '../src/github/task-envelope.js';

function body(object) {
  return `Task\n\n\`\`\`patch-poller-task\n${JSON.stringify(object)}\n\`\`\``;
}

test('task protocol carries a normalized controller plan as revision-bound data', () => {
  const task = {
    protocol: 'patch-poller/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'Apply deterministic bundle.',
    controllerPlan: {
      protocol: 'patch-poller/controller-plan-v1',
      files: [{ path: 'src/a.mjs', content: 'export default 1;\n' }],
      operations: [{ id: 'syntax', operation: 'node.syntax-check', params: { path: 'src/a.mjs' } }],
      assertions: [{ kind: 'exit-equals', operation: 'syntax', value: 0 }]
    }
  };
  const parsed = parseTaskEnvelope(body(task));
  assert.equal(parsed.envelope.controllerPlan.protocol, 'patch-poller/controller-plan-v1');
  const changed = structuredClone(task);
  changed.controllerPlan.files[0].content = 'export default 2;\n';
  assert.notEqual(parseTaskEnvelope(body(changed)).revision, parsed.revision);
});

test('controller-plan tasks cannot simultaneously select a coding tool', () => {
  assert.throws(() => parseTaskEnvelope(body({
    protocol: 'patch-poller/task-v1',
    target: { repository: 'iteathen/example' },
    instructions: 'No mixed authority.',
    preferredTool: 'codex',
    controllerPlan: { protocol: 'patch-poller/controller-plan-v1' }
  })), /cannot also select/u);
});
