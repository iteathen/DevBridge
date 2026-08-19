import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecisionScopeCheckpoint,
  decisionScopeValidity,
  invalidateDecisionScopeIfChanged,
} from '../src/run/decision-scope.js';

const now = 1_700_000_000_000;

function approvedCheckpoint() {
  const checkpoint = createDecisionScopeCheckpoint({
    runId: 'run-1',
    taskRevision: 'a'.repeat(64),
    baselineSha: '1'.repeat(40),
    decisionClasses: ['public-contract', 'architectural-change'],
    scopePaths: ['specs/A.md', 'src/domain/api.js'],
    bounds: { preserveApi: true, maxFiles: 12 },
    approvalTtlMs: 60_000,
    nowMs: now,
  });
  checkpoint.state = 'approved';
  checkpoint.resolvedAt = new Date(now + 1).toISOString();
  return checkpoint;
}

test('decision-scope approval remains valid for the same normalized scope and bounds', () => {
  const checkpoint = approvedCheckpoint();
  const result = decisionScopeValidity(checkpoint, {
    decisionClasses: ['architectural-change', 'public-contract'],
    scopePaths: ['src/domain/api.js', 'specs/A.md'],
    bounds: { maxFiles: 12, preserveApi: true },
    nowMs: now + 10_000,
  });
  assert.equal(result.valid, true);
  assert.equal(result.currentDigest, checkpoint.subjectDigest);
});

test('material scope path, class, or bound change invalidates decision-scope approval', () => {
  const changedPath = decisionScopeValidity(approvedCheckpoint(), {
    decisionClasses: ['public-contract', 'architectural-change'],
    scopePaths: ['specs/B.md', 'src/domain/api.js'],
    bounds: { preserveApi: true, maxFiles: 12 },
    nowMs: now + 10_000,
  });
  assert.equal(changedPath.valid, false);
  assert.equal(changedPath.reason, 'decision-scope-changed');

  const changedClass = decisionScopeValidity(approvedCheckpoint(), {
    decisionClasses: ['public-contract'],
    scopePaths: ['specs/A.md', 'src/domain/api.js'],
    bounds: { preserveApi: true, maxFiles: 12 },
    nowMs: now + 10_000,
  });
  assert.equal(changedClass.reason, 'decision-scope-changed');

  const changedBound = decisionScopeValidity(approvedCheckpoint(), {
    decisionClasses: ['public-contract', 'architectural-change'],
    scopePaths: ['specs/A.md', 'src/domain/api.js'],
    bounds: { preserveApi: false, maxFiles: 12 },
    nowMs: now + 10_000,
  });
  assert.equal(changedBound.reason, 'decision-scope-changed');
});

test('scope change marks approved checkpoint superseded and records the invalidation time', () => {
  const checkpoint = approvedCheckpoint();
  const result = invalidateDecisionScopeIfChanged(checkpoint, {
    decisionClasses: ['public-contract', 'architectural-change'],
    scopePaths: ['specs/A.md', 'src/domain/api.js', 'src/domain/new-api.js'],
    bounds: { preserveApi: true, maxFiles: 12 },
  }, { nowMs: now + 20_000 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'decision-scope-changed');
  assert.equal(checkpoint.state, 'superseded');
  assert.equal(checkpoint.supersededAt, new Date(now + 20_000).toISOString());
});

test('silence and expiry never become decision-scope approval', () => {
  const pending = createDecisionScopeCheckpoint({
    runId: 'run-1',
    taskRevision: 'a'.repeat(64),
    baselineSha: '1'.repeat(40),
    decisionClasses: ['public-contract'],
    scopePaths: ['specs/A.md'],
    bounds: {},
    approvalTtlMs: 60_000,
    nowMs: now,
  });
  assert.equal(decisionScopeValidity(pending, {
    decisionClasses: ['public-contract'], scopePaths: ['specs/A.md'], bounds: {}, nowMs: now + 1,
  }).reason, 'decision-scope-not-approved');

  const approved = approvedCheckpoint();
  assert.equal(decisionScopeValidity(approved, {
    decisionClasses: ['public-contract', 'architectural-change'],
    scopePaths: ['specs/A.md', 'src/domain/api.js'],
    bounds: { preserveApi: true, maxFiles: 12 },
    nowMs: Date.parse(approved.expiresAt),
  }).reason, 'decision-scope-expired');
});
