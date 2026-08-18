import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextCapsule, fitContextCapsule } from '../src/context/context-capsule.js';

test('builds self-contained task identity and compacts expendable context', () => {
  const task = {
    queueRepository: 'iteathen/PATCH-POLLER',
    issueNumber: 12,
    actorId: '1775584',
    revision: 'a'.repeat(64),
    envelope: {
      target: { repository: 'iteathen/repo' },
      instructions: 'x'.repeat(20_000),
      context: { constraints: ['Keep API stable'], summary: 'prior' }
    }
  };
  const capsule = buildContextCapsule({ task, runtime: { outputTail: 'y'.repeat(30_000), nextStep: 'test' } });
  const fitted = fitContextCapsule(capsule, 12_000);
  assert.equal(fitted.task.issueNumber, 12);
  assert.deepEqual(fitted.constraints, ['Keep API stable']);
  assert.equal(fitted.compacted, true);
  assert.match(fitted.digest, /^[0-9a-f]{64}$/);
});
