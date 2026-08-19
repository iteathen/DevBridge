import test from 'node:test';
import assert from 'node:assert/strict';
import { RunCoordinator } from '../src/run/run-coordinator.js';

class MemoryStore {
  data = new Map();
  async get(key) { return structuredClone(this.data.get(key)); }
  async set(key, value) { this.data.set(key, structuredClone(value)); }
  async entries(prefix = '') {
    return [...this.data.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key, structuredClone(value)]);
  }
}

const revision = 'b'.repeat(64);
const bodyDigest = 'c'.repeat(64);

function task() {
  return {
    queueRepository: 'owner/queue',
    issueNumber: 7,
    actorId: '1',
    contentSha256: 'a'.repeat(64),
    revision,
    provenance: {
      verified: true,
      reason: null,
      contentSha256: 'a'.repeat(64),
      creatorActorId: '1',
      currentEditorActorId: null,
      editorActorIds: [],
      editCount: 0,
      redactedEditCount: 0,
      historyComplete: true,
      lastEditedAt: null,
    },
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'do it',
      preferredTool: 'fixture',
      context: { constraints: [] },
    },
  };
}

function provenance({ verified = true, reason = null, editor = null } = {}) {
  return {
    verified,
    reason,
    contentSha256: bodyDigest,
    creatorActorId: '1',
    currentEditorActorId: editor,
    editorActorIds: editor == null ? [] : [editor],
    editCount: editor == null ? 0 : 2,
    redactedEditCount: 0,
    historyComplete: true,
    lastEditedAt: editor == null ? null : '2026-08-18T23:00:00Z',
  };
}

async function seedWaiting(store) {
  const t = task();
  const runId = `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`;
  const key = `run.owner/queue#${t.issueNumber}.${t.revision}`;
  await store.set(key, {
    version: 1,
    runId,
    task: t,
    stage: 'waiting-feedback',
    turn: 1,
    turnLimit: 8,
    createdAt: new Date().toISOString(),
    prior: {
      summary: null,
      decisions: [],
      provenance: [],
      progress: [],
      changedFiles: [],
      tests: [],
      git: null,
      blockers: ['waiting'],
      nextStep: null,
      outputTail: null,
      receipt: null,
      liveness: null,
    },
    lastFeedbackCommentId: 0,
    publication: { published: false },
    transientRetry: null,
  });
  return { t, runId, key };
}

function coordinator({ store, feedbackSource, statusReporter = null }) {
  return new RunCoordinator({
    stateStore: store,
    workspaceManager: { prepareRun: async () => { throw new Error('workspace must not be prepared in this feedback-only fixture'); } },
    processRunner: { run: async () => { throw new Error('worker must not run in this feedback-only fixture'); } },
    statusReporter,
    feedbackSource,
    queueRepository: 'owner/queue',
    tools: {},
    defaultTool: null,
  });
}

test('rejected authority-shaped feedback is persisted and projected into waiting status', async () => {
  const store = new MemoryStore();
  const { t, key } = await seedWaiting(store);
  const reports = [];
  const rejected = {
    commentId: 9,
    actorId: '1',
    reason: 'untrusted-editor',
    provenance: provenance({ verified: false, reason: 'untrusted-editor', editor: '999' }),
  };
  const result = await coordinator({
    store,
    feedbackSource: {
      pollWaitingRun: async () => ({
        feedback: null,
        rejected: [rejected],
        unchanged: false,
        highestCommentId: 9,
      }),
    },
    statusReporter: { publish: async (value) => { reports.push(value); return { published: true }; } },
  }).executeTask(t);

  assert.equal(result.status, 'waiting-feedback');
  assert.equal(result.rejectedFeedbackCount, 1);
  const persisted = await store.get(key);
  assert.equal(persisted.lastFeedbackCommentId, 9);
  assert.equal(persisted.prior.provenance.length, 1);
  assert.equal(persisted.prior.provenance[0].source, 'github-feedback-rejected');
  assert.equal(persisted.prior.provenance[0].reason, 'untrusted-editor');
  assert.equal(persisted.prior.provenance[0].content.contentSha256, bodyDigest);
  assert.equal(persisted.prior.provenance[0].content.currentEditorActorId, '999');

  const report = reports.at(-1);
  assert.equal(report.stage, 'WAITING_FEEDBACK');
  const projected = report.capsule.provenance.find((entry) => entry.source === 'github-feedback-rejected');
  assert.ok(projected);
  assert.equal(projected.reason, 'untrusted-editor');
  assert.equal(projected.content.currentEditorActorId, '999');
  assert.match(report.summary, /creator\/editor provenance/u);
});

test('accepted cancel feedback persists exact content digest and verified editor provenance in the decision', async () => {
  const store = new MemoryStore();
  const { t, key } = await seedWaiting(store);
  const acceptedProvenance = provenance({ verified: true, editor: '1' });
  const result = await coordinator({
    store,
    feedbackSource: {
      pollWaitingRun: async () => ({
        feedback: {
          protocol: 'devbridge/feedback-v1',
          runId: `pp-${t.issueNumber}-${t.revision.slice(0, 16)}`,
          taskRevision: t.revision,
          action: 'cancel',
          instructions: 'stop here',
          contentSha256: bodyDigest,
          commentId: 10,
          actorId: '1',
          actorLogin: 'trusted',
          provenance: acceptedProvenance,
        },
        rejected: [],
        unchanged: false,
        highestCommentId: 10,
      }),
    },
  }).executeTask(t);

  assert.equal(result.status, 'cancelled');
  const persisted = await store.get(key);
  assert.equal(persisted.stage, 'cancelled');
  assert.equal(persisted.lastFeedbackCommentId, 10);
  assert.equal(persisted.prior.provenance[0].source, 'github-feedback');
  assert.equal(persisted.prior.provenance[0].content.contentSha256, bodyDigest);
  assert.equal(persisted.prior.provenance[0].content.verified, true);

  const decision = persisted.prior.decisions.at(-1);
  assert.equal(decision.source, 'trusted-feedback');
  assert.equal(decision.action, 'cancel');
  assert.equal(decision.contentSha256, bodyDigest);
  assert.equal(decision.contentProvenance.verified, true);
  assert.equal(decision.contentProvenance.currentEditorActorId, '1');
});

test('provenance infrastructure failure remains retryable without advancing the cursor', async () => {
  const store = new MemoryStore();
  const { t, key } = await seedWaiting(store);
  const result = await coordinator({
    store,
    feedbackSource: {
      pollWaitingRun: async () => ({
        feedback: null,
        rejected: [{
          commentId: 11,
          actorId: '1',
          reason: 'provenance-unavailable',
          provenance: provenance({ verified: false, reason: 'provenance-unavailable' }),
        }],
        unchanged: false,
        highestCommentId: 0,
        provenanceRetryRequired: true,
      }),
    },
  }).executeTask(t);

  assert.equal(result.status, 'waiting-feedback');
  const persisted = await store.get(key);
  assert.equal(persisted.lastFeedbackCommentId, 0);
  assert.equal(persisted.prior.provenance[0].reason, 'provenance-unavailable');
});
