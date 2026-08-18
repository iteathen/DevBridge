import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeControllerPlan } from '../src/run/controller-plan.js';

test('expectedChangedPaths may only restate persistent proposal paths in controller-plan-v1', () => {
  const exact = normalizeControllerPlan({
    protocol: 'patch-poller/controller-plan-v1',
    files: [{ scope: 'persistent', action: 'create', path: 'src/a.txt', content: 'a\n' }],
    operations: [{ id: 'build', operation: 'cmake.build', params: { buildDir: 'build' } }],
    assertions: [],
    expectedChangedPaths: ['src/a.txt'],
  });
  assert.deepEqual(exact.expectedChangedPaths, ['src/a.txt']);

  assert.throws(() => normalizeControllerPlan({
    protocol: 'patch-poller/controller-plan-v1',
    files: [{ scope: 'persistent', action: 'create', path: 'src/a.txt', content: 'a\n' }],
    operations: [{ id: 'build', operation: 'cmake.build', params: { buildDir: 'build' } }],
    assertions: [],
    expectedChangedPaths: ['generated.bin', 'src/a.txt'],
  }), /operation-generated persistent outputs require a separate locally registered output contract/u);

  assert.throws(() => normalizeControllerPlan({
    protocol: 'patch-poller/controller-plan-v1',
    files: [{ scope: 'persistent', action: 'create', path: 'src/a.txt', content: 'a\n' }],
    operations: [],
    assertions: [],
    expectedChangedPaths: [],
  }), /must exactly equal persistent file proposal paths/u);
});
