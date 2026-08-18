import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('preserves bounded handoff text exactly and publishes its digest', () => {
  const handoff = 'CONTEXT-ROUNDTRIP-V1\nnonce=abc123\npayload={"x":1}\n';
  const task = {
    queueRepository: 'iteathen/PATCH-POLLER',
    issueNumber: 13,
    actorId: '1775584',
    revision: 'b'.repeat(64),
    envelope: {
      target: { repository: 'iteathen/repo' },
      instructions: 'Relay context.',
      context: { summary: 'relay', handoff }
    }
  };
  const capsule = buildContextCapsule({ task });
  assert.equal(capsule.handoff, handoff);
  assert.equal(capsule.handoffSha256, createHash('sha256').update(handoff, 'utf8').digest('hex'));
  const fitted = fitContextCapsule({ ...capsule, outputTail: 'z'.repeat(80_000) }, 32_000);
  assert.equal(fitted.handoff, handoff);
  assert.equal(fitted.handoffSha256, capsule.handoffSha256);
});
