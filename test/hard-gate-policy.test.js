import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkpointIdFor,
  classifySensitiveCandidate,
  createHardGateCheckpoint,
  decisionAuthorityActors,
  decisionMatchesCheckpoint,
  decisionScopeSubjectDigest,
} from '../src/run/hard-gate-policy.js';

const taskRevision = 'a'.repeat(64);
const subjectDigest = 'b'.repeat(64);

function checkpoint(nowMs = 1_700_000_000_000) {
  return createHardGateCheckpoint({
    runId: 'run-1',
    taskRevision,
    baselineSha: '1'.repeat(40),
    subjectDigest,
    decisionClasses: ['security-capability'],
    reasons: [],
    changedFiles: ['src/security/policy.js'],
    approvalTtlMs: 60_000,
    nowMs,
  });
}

test('classifies sensitive security/bootstrap/Git/workflow/spec paths locally', () => {
  const result = classifySensitiveCandidate([
    'src/security/policy.js',
    'src/bootstrap/transactional-bootstrap.mjs',
    'src/github/rest-client.js',
    '.github/workflows/ci.yml',
    'specs/DB-007-human-checkpoints.md',
  ], { architectureFileThreshold: 99, architectureOwnerThreshold: 99 });
  assert.equal(result.required, true);
  assert.deepEqual(result.decisionClasses, [
    'bootstrap-self-update',
    'git-github-publication',
    'public-contract',
    'security-capability',
    'workflow-release',
  ]);
});

test('hard-gate implementation and control-plane effect wiring are themselves security-sensitive', () => {
  const result = classifySensitiveCandidate([
    'src/app/runtime.js',
    'src/run/hard-gate-controller.js',
    'src/run/decision-gated-coordinator.js',
    'src/run/controller-plan-executor.js',
    'src/runtime/deterministic-operation-registry.js',
    'src/state/json-state-store.js',
  ], { architectureFileThreshold: 99, architectureOwnerThreshold: 99 });
  assert.equal(result.required, true);
  assert.deepEqual(result.decisionClasses, ['security-capability']);
  const reason = result.reasons.find((entry) => entry.decisionClass === 'security-capability');
  assert.deepEqual(reason.paths, [
    'src/app/runtime.js',
    'src/run/controller-plan-executor.js',
    'src/run/decision-gated-coordinator.js',
    'src/run/hard-gate-controller.js',
    'src/runtime/deterministic-operation-registry.js',
    'src/state/json-state-store.js',
  ]);
});

test('package and repository workflow metadata trigger the workflow/release gate', () => {
  const result = classifySensitiveCandidate([
    'package.json',
    '.github/dependabot.yml',
  ], { architectureFileThreshold: 99, architectureOwnerThreshold: 99 });
  assert.deepEqual(result.decisionClasses, ['workflow-release']);
});

test('broad cross-owner change triggers architectural hard gate while narrow ordinary source change does not', () => {
  assert.equal(classifySensitiveCandidate(['src/domain/a.js']).required, false);
  const broad = classifySensitiveCandidate([
    'src/app/a.js',
    'src/context/b.js',
    'src/state/c.js',
    'docs/notes.md',
  ], { architectureFileThreshold: 99, architectureOwnerThreshold: 4 });
  assert.ok(broad.decisionClasses.includes('architectural-change'));
});

test('decision authority is intersection across every triggered local class', () => {
  const actors = decisionAuthorityActors({
    'security-capability': ['1', '2'],
    'git-github-publication': ['2', '3'],
    'public-contract': ['2', '4'],
  }, ['security-capability', 'git-github-publication', 'public-contract']);
  assert.deepEqual(actors, ['2']);
  assert.deepEqual(decisionAuthorityActors({ 'security-capability': ['1'] }, ['security-capability', 'public-contract']), []);
});

test('decision-scope digest is canonical across ordering but changes when scope or bounds change', () => {
  const a = decisionScopeSubjectDigest({
    decisionClasses: ['public-contract', 'architectural-change'],
    scopePaths: ['specs/B.md', 'specs/A.md'],
    bounds: { z: 2, a: 1 },
  });
  const b = decisionScopeSubjectDigest({
    decisionClasses: ['architectural-change', 'public-contract'],
    scopePaths: ['specs/A.md', 'specs/B.md'],
    bounds: { a: 1, z: 2 },
  });
  assert.equal(a, b);
  assert.notEqual(a, decisionScopeSubjectDigest({
    decisionClasses: ['architectural-change', 'public-contract'],
    scopePaths: ['specs/A.md', 'specs/C.md'],
    bounds: { a: 1, z: 2 },
  }));
  assert.notEqual(a, decisionScopeSubjectDigest({
    decisionClasses: ['architectural-change', 'public-contract'],
    scopePaths: ['specs/A.md', 'specs/B.md'],
    bounds: { a: 1, z: 3 },
  }));
});

test('renewed same-subject hard gates receive fresh checkpoint IDs while stable scope IDs can be deterministic', () => {
  assert.notEqual(checkpoint(1_700_000_000_000).checkpointId, checkpoint(1_700_000_060_001).checkpointId);
  const stableA = checkpointIdFor({
    runId: 'run-1', taskRevision, bindingMode: 'decision-scope', subjectDigest, decisionClasses: ['public-contract'],
  });
  const stableB = checkpointIdFor({
    runId: 'run-1', taskRevision, bindingMode: 'decision-scope', subjectDigest, decisionClasses: ['public-contract'],
  });
  assert.equal(stableA, stableB);
});

test('decision matching rejects stale run/task/checkpoint/digest and expiry', () => {
  const cp = checkpoint();
  const exact = {
    runId: cp.runId,
    taskRevision: cp.taskRevision,
    checkpointId: cp.checkpointId,
    subjectDigest: cp.subjectDigest,
  };
  const activeNow = Date.parse(cp.createdAt) + 1;
  assert.equal(decisionMatchesCheckpoint(cp, exact, { nowMs: activeNow }).ok, true);
  assert.equal(decisionMatchesCheckpoint(cp, { ...exact, runId: 'other' }, { nowMs: activeNow }).reason, 'decision-run-mismatch');
  assert.equal(decisionMatchesCheckpoint(cp, { ...exact, taskRevision: 'c'.repeat(64) }, { nowMs: activeNow }).reason, 'decision-task-mismatch');
  assert.equal(decisionMatchesCheckpoint(cp, { ...exact, checkpointId: 'checkpoint-other' }, { nowMs: activeNow }).reason, 'decision-checkpoint-mismatch');
  assert.equal(decisionMatchesCheckpoint(cp, { ...exact, subjectDigest: 'd'.repeat(64) }, { nowMs: activeNow }).reason, 'decision-subject-mismatch');
  assert.equal(decisionMatchesCheckpoint(cp, exact, { nowMs: Date.parse(cp.expiresAt) }).reason, 'checkpoint-expired');
});
