import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueTaskSource } from '../src/github/issue-task-source.js';
import { contentSha256 } from '../src/github/content-provenance.js';

const envelope = `\`\`\`patch-poller-task\n${JSON.stringify({ protocol: 'patch-poller/task-v1', target: { repository: 'iteathen/repo' }, instructions: 'Do work.' })}\n\`\`\``;

function verified(candidate) {
  return {
    verified: true,
    reason: null,
    nodeId: candidate.nodeId,
    expectedType: 'Issue',
    contentSha256: contentSha256(candidate.body),
    creatorActorId: String(candidate.authorId),
    creatorLogin: candidate.authorLogin ?? null,
    currentEditorActorId: null,
    editorActorIds: [],
    editCount: 0,
    redactedEditCount: 0,
    historyComplete: true,
    lastEditedAt: null,
  };
}

function clientFor(data, { onInvalidate = null } = {}) {
  return {
    rateBudget: { snapshot: () => ({ pollIntervalMs: 60_000 }) },
    request: async () => ({ notModified: false, data }),
    invalidateConditional: onInvalidate ?? (async () => {}),
  };
}

test('accepts only trusted issue creators whose exact current content provenance verifies', async () => {
  const issues = [
    { id: 1, node_id: 'I_1', number: 1, title: 'good', body: envelope, user: { id: 1775584, login: 'iteathen' } },
    { id: 2, node_id: 'I_2', number: 2, title: 'bad', body: envelope, user: { id: 999, login: 'bad' } },
    { id: 3, node_id: 'I_3', number: 3, title: 'pr', body: envelope, user: { id: 1775584 }, pull_request: {} }
  ];
  let candidatesSeen = null;
  const source = new IssueTaskSource({
    client: clientFor(issues),
    queueRepository: 'iteathen/PATCH-POLLER',
    taskLabel: 'patch-poller:ready',
    trustedActorIds: ['1775584'],
    contentProvenance: {
      verifyMany: async (candidates) => {
        candidatesSeen = candidates;
        return candidates.map(verified);
      },
    },
  });
  const result = await source.poll();
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].issueNumber, 1);
  assert.equal(result.tasks[0].contentSha256, contentSha256(envelope));
  assert.equal(result.tasks[0].provenance.verified, true);
  assert.deepEqual(candidatesSeen.map((entry) => entry.nodeId), ['I_1']);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'untrusted-creator');
  assert.equal(result.rejected[0].provenance.contentSha256, contentSha256(envelope));
});

test('trusted issue creator plus untrusted editor provenance is rejected', async () => {
  const issue = { id: 4, node_id: 'I_4', number: 4, title: 'edited', body: envelope, user: { id: 1775584, login: 'iteathen' } };
  const source = new IssueTaskSource({
    client: clientFor([issue]),
    queueRepository: 'iteathen/PATCH-POLLER',
    taskLabel: 'patch-poller:ready',
    trustedActorIds: ['1775584'],
    contentProvenance: {
      verifyMany: async ([candidate]) => [{
        ...verified(candidate),
        verified: false,
        reason: 'untrusted-editor',
        currentEditorActorId: '999',
        editorActorIds: ['999'],
        editCount: 2,
        historyComplete: true,
      }],
    },
  });
  const result = await source.poll();
  assert.equal(result.tasks.length, 0);
  assert.equal(result.rejected[0].reason, 'untrusted-editor');
  assert.equal(result.rejected[0].provenance.currentEditorActorId, '999');
});

test('an untrusted original is rejected before a later trusted editor could launder authority', async () => {
  const issue = { id: 5, node_id: 'I_5', number: 5, title: 'launder', body: envelope, user: { id: 999, login: 'bad' } };
  let provenanceCalled = false;
  const source = new IssueTaskSource({
    client: clientFor([issue]),
    queueRepository: 'iteathen/PATCH-POLLER',
    taskLabel: 'patch-poller:ready',
    trustedActorIds: ['1775584'],
    contentProvenance: { verifyMany: async () => { provenanceCalled = true; return []; } },
  });
  const result = await source.poll();
  assert.equal(result.tasks.length, 0);
  assert.equal(result.rejected[0].reason, 'untrusted-creator');
  assert.equal(provenanceCalled, false);
});

test('content race invalidates REST cache so the latest issue bytes are fetched again', async () => {
  const issue = { id: 6, node_id: 'I_6', number: 6, title: 'race', body: envelope, user: { id: 1775584, login: 'iteathen' } };
  let invalidated = null;
  const source = new IssueTaskSource({
    client: clientFor([issue], { onInvalidate: async (requestPath) => { invalidated = requestPath; } }),
    queueRepository: 'iteathen/PATCH-POLLER',
    taskLabel: 'patch-poller:ready',
    trustedActorIds: ['1775584'],
    contentProvenance: {
      verifyMany: async ([candidate]) => [{
        ...verified(candidate),
        verified: false,
        reason: 'provenance-content-race',
        observedContentSha256: contentSha256(`${candidate.body}\nchanged`),
      }],
    },
  });
  const result = await source.poll();
  assert.equal(result.tasks.length, 0);
  assert.equal(result.rejected[0].reason, 'provenance-content-race');
  assert.match(invalidated, /\/issues\?/u);
});

test('provenance infrastructure failure fails closed and clears the conditional validator for retry', async () => {
  const issue = { id: 7, node_id: 'I_7', number: 7, title: 'retry', body: envelope, user: { id: 1775584, login: 'iteathen' } };
  let invalidated = null;
  const source = new IssueTaskSource({
    client: clientFor([issue], { onInvalidate: async (requestPath) => { invalidated = requestPath; } }),
    queueRepository: 'iteathen/PATCH-POLLER',
    taskLabel: 'patch-poller:ready',
    trustedActorIds: ['1775584'],
    contentProvenance: { verifyMany: async () => { throw new Error('GraphQL temporarily unavailable'); } },
  });
  const result = await source.poll();
  assert.equal(result.tasks.length, 0);
  assert.equal(result.rejected[0].reason, 'provenance-unavailable');
  assert.match(result.rejected[0].detail, /temporarily unavailable/u);
  assert.match(invalidated, /\/issues\?/u);
});
