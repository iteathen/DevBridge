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
    contentSha256: 'c'.repeat(64),
    provenance: {
      verified: true,
      reason: null,
      contentSha256: 'c'.repeat(64),
      creatorActorId: '1775584',
      currentEditorActorId: '1775585',
      editorActorIds: ['1775584', '1775585'],
      editCount: 2,
      redactedEditCount: 1,
      historyComplete: true,
      lastEditedAt: '2026-08-18T22:00:00Z',
    },
    envelope: {
      target: { repository: 'iteathen/repo' },
      instructions: 'x'.repeat(20_000),
      context: { constraints: ['Keep API stable'], summary: 'prior' }
    }
  };
  const capsule = buildContextCapsule({
    task,
    prior: {
      provenance: [{ source: 'github-feedback-rejected', commentId: 99, reason: 'untrusted-editor', contentSha256: 'd'.repeat(64) }],
    },
    runtime: { outputTail: 'y'.repeat(30_000), nextStep: 'test' }
  });
  assert.equal(capsule.task.contentSha256, 'c'.repeat(64));
  assert.equal(capsule.provenance[0].content.verified, true);
  assert.equal(capsule.provenance[0].content.editCount, 2);
  assert.equal(capsule.provenance[0].content.redactedEditCount, 1);
  assert.equal(capsule.provenance[1].source, 'github-feedback-rejected');
  assert.equal(JSON.stringify(capsule).includes('edit diff'), false);

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
