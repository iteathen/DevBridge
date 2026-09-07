import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandidateRecovery } from '../src/run/run-coordinator/candidate-recovery.js';
import { FeedbackContinuation } from '../src/run/run-coordinator/feedback-continuation.js';
import { FinalizationPolicy } from '../src/run/run-coordinator/finalization-policy.js';
import {
  boundedOutput,
  projectCandidateIdentity,
  projectContentEvidence,
} from '../src/run/run-coordinator/projections.js';
import { RetryWindow, RetryWindowError } from '../src/run/run-coordinator/retry-window.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('projection owner emits only bounded local contract values', () => {
  assert.equal(boundedOutput({ stdout: 'a'.repeat(8_001), stderr: '' }).length, 8_000);
  assert.deepEqual(projectCandidateIdentity({
    branch: 'work', baseSha: 'a', headSha: 'b', dirty: false,
  }), {
    branch: 'work', baseSha: 'a', publicationBaseSha: 'a', headSha: 'b', dirty: false,
  });
  assert.deepEqual(projectContentEvidence({
    verified: true,
    editorActorIds: Array.from({ length: 25 }, (_, index) => String(index)),
    editCount: 2,
    historyComplete: true,
    foreign: 'discarded',
  }), {
    verified: true,
    reason: null,
    contentSha256: null,
    creatorActorId: null,
    currentEditorActorId: null,
    editorActorIds: Array.from({ length: 20 }, (_, index) => String(index)),
    editCount: 2,
    redactedEditCount: null,
    historyComplete: true,
    lastEditedAt: null,
  });
});

test('retry owner preserves the absolute bounded schedule and rejects malformed deadlines', async () => {
  const waits = [];
  const now = Date.parse('2026-08-28T12:00:00.000Z');
  const owner = new RetryWindow({ now: () => now, wait: async (value) => waits.push(value) });
  const first = owner.schedule({ current: null, completed: 1, limit: 8, classification: 'TRANSIENT', kind: 'capacity' });
  assert.deepEqual(first.scheduled, {
    attempts: 1,
    delayMs: 5_000,
    notBefore: '2026-08-28T12:00:05.000Z',
  });
  await owner.respect(first.record);
  assert.deepEqual(waits, [5_000]);

  const capped = owner.schedule({ current: { attempts: 20 }, completed: 2, limit: 8 });
  assert.equal(capped.record.delayMs, 60_000);
  const exhausted = owner.schedule({ current: capped.record, completed: 8, limit: 8 });
  assert.equal(exhausted.scheduled, null);
  assert.equal(exhausted.record.exhausted, true);
  await assert.rejects(() => owner.respect({ notBefore: 'not-a-time' }), RetryWindowError);
});

function continuation() {
  return new FeedbackContinuation({
    recordKinds: { accepted: 'accepted-kind', rejected: 'rejected-kind', decision: 'decision-kind' },
    projectEvidence: (value) => value ? { digest: value.digest ?? null } : null,
    now: () => '2026-08-28T12:00:00.000Z',
  });
}

test('feedback owner interprets rejected evidence without granting continuation', () => {
  const result = continuation().interpret({
    poll: {
      highestCommentId: 4,
      rejected: [{ commentId: 4, actorId: '2', reason: 'untrusted', provenance: { digest: 'bad' } }],
      feedback: null,
      provenanceRetryRequired: true,
    },
    provenance: [],
    cursor: 1,
    completed: 3,
    limit: 3,
    extension: 8,
  });
  assert.equal(result.kind, 'idle');
  assert.equal(result.cursor, 4);
  assert.equal(result.retryRequired, true);
  assert.deepEqual(result.provenance[0], {
    source: 'rejected-kind',
    accepted: false,
    action: null,
    commentId: 4,
    actorId: '2',
    reason: 'untrusted',
    content: { digest: 'bad' },
    recordedAt: '2026-08-28T12:00:00.000Z',
  });
});

test('feedback owner returns bounded continue and cancel decisions without changing a stage', () => {
  const continued = continuation().interpret({
    poll: {
      highestCommentId: 5,
      rejected: [],
      feedback: {
        action: 'continue', actorId: '3', commentId: 5, contentSha256: 'abc',
        provenance: { digest: 'abc' }, instructions: 'proceed',
      },
    },
    provenance: [], cursor: 4, completed: 3, limit: 3, extension: 8,
  });
  assert.equal(continued.kind, 'continue');
  assert.equal(continued.limit, 11);
  assert.deepEqual(continued.decision, {
    source: 'decision-kind', action: 'continue', actorId: '3', commentId: 5,
    contentSha256: 'abc', contentProvenance: { digest: 'abc' }, instructions: 'proceed',
  });

  const cancelled = continuation().interpret({
    poll: {
      feedback: {
        action: 'cancel', actorId: '3', commentId: 6, contentSha256: 'def',
        provenance: { digest: 'def' }, instructions: null,
      },
    },
    provenance: [], cursor: 5, completed: 1, limit: 3, extension: 8,
  });
  assert.equal(cancelled.kind, 'cancel');
  assert.equal(cancelled.decision.note, null);
});

test('candidate recovery owner bounds history, attempts, and identity reasons', () => {
  const owner = new CandidateRecovery({ now: () => '2026-08-28T12:00:00.000Z' });
  const history = Array.from({ length: 20 }, (_, index) => ({ index }));
  const rebased = owner.baselineReverification({
    reconciliation: { fromBaseSha: 'a', toBaseSha: 'b', fromHeadSha: 'c', toHeadSha: 'd' },
    snapshot: { publicationBaseSha: 'b', headSha: 'd' },
    history,
    summary: 'reverify',
    nextStep: 'repeat',
  });
  assert.equal(rebased.history.length, 20);
  assert.equal(rebased.history.at(-1).toBaseSha, 'b');
  assert.deepEqual(owner.boundedReverification({ completed: 1, limit: 3, exhausted: { blocker: 'stop' } }), {
    exhausted: false, next: 2,
  });
  assert.deepEqual(owner.boundedReverification({ completed: 3, limit: 3, exhausted: { blocker: 'stop' } }), {
    exhausted: true, blocker: 'stop',
  });
  const local = owner.localReverification({
    observed: { dirty: true, headSha: 'new', publicationBaseSha: 'base-2' },
    verified: { dirty: false, headSha: 'old', publicationBaseSha: 'base-1' },
    completed: 1,
    limit: 3,
    exhausted: { blocker: 'stop' },
  });
  assert.deepEqual(local.reasons, [
    'the managed worktree became dirty',
    'HEAD moved from verified old to new',
    'publication baseline changed from base-1 to base-2',
  ]);
});

test('finalization policy calculates identity and publication disposition without effects', () => {
  const owner = new FinalizationPolicy();
  const empty = { baseSha: 'a', publicationBaseSha: 'a', headSha: 'a', changedFiles: [], dirty: false };
  assert.equal(owner.identityChanged(empty, empty), false);
  assert.deepEqual(owner.publication({
    snapshot: empty, enabled: true, alreadyPublished: false, alreadySkipped: false, forceEmpty: false,
  }), { kind: 'skip', baseSha: 'a' });
  const changed = { ...empty, headSha: 'b', changedFiles: ['value.js'] };
  assert.deepEqual(owner.publication({
    snapshot: changed, enabled: true, alreadyPublished: false, alreadySkipped: false, forceEmpty: false,
  }), { kind: 'publish', baseSha: 'a', expectedHeadSha: 'b' });
  const completed = owner.completion({
    snapshot: changed,
    branch: 'work',
    automatic: true,
    publication: { published: true },
  });
  assert.equal(completed.published, true);
  assert.match(completed.summary, /published task branch work/u);
});

test('nested run mechanics are isolated and only the parent owns stage authority and topology', async () => {
  const nestedDir = path.join(ROOT, 'src', 'run', 'run-coordinator');
  const names = (await readdir(nestedDir)).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(names, [
    'candidate-recovery.js',
    'feedback-continuation.js',
    'finalization-policy.js',
    'projections.js',
    'retry-window.js',
  ]);
  const forbidden = /(?:^\s*import\s|\.stage\s*=|stateStore|statusReporter|workspaceManager|processRunner|sealCandidate|publishTaskBranch|controllerPlan|github|hyper-v|libvirt|windows|linux|codex)/imu;
  for (const name of names) {
    const source = await readFile(path.join(nestedDir, name), 'utf8');
    assert.doesNotMatch(source, forbidden, `${name} must remain topology- and authority-free`);
  }

  const parent = await readFile(path.join(ROOT, 'src', 'run', 'run-coordinator.js'), 'utf8');
  for (const name of names) {
    assert.match(parent, new RegExp(`\\./run-coordinator/${name.replace('.', '\\.')}['"]`, 'u'));
  }
  assert.match(parent, /state\.stage\s*=/u);
});
