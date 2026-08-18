import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueTaskSource } from '../src/github/issue-task-source.js';

const envelope = `\`\`\`patch-poller-task\n${JSON.stringify({ protocol: 'patch-poller/task-v1', target: { repository: 'iteathen/repo' }, instructions: 'Do work.' })}\n\`\`\``;
const baseIssueUrl = 'https://api.github.com/repos/iteathen/PATCH-POLLER/issues';

function clientFor(issues, comments) {
  return {
    rateBudget: { snapshot: () => ({ pollIntervalMs: 60_000 }) },
    request: async (_method, requestPath) => {
      if (requestPath.includes('/issues/comments?')) return { notModified: false, data: comments };
      return { notModified: false, data: issues };
    }
  };
}

test('task authority comes only from trusted unedited append-only comments', async () => {
  const issues = [
    { id: 1, number: 1, title: 'good', body: envelope, user: { id: 999, login: 'body-author-is-irrelevant' } },
    { id: 2, number: 2, title: 'edited', body: '', user: { id: 1775584, login: 'iteathen' } },
    { id: 3, number: 3, title: 'pr', body: envelope, user: { id: 1775584 }, pull_request: {} },
    { id: 4, number: 4, title: 'body-only', body: envelope, user: { id: 1775584, login: 'iteathen' } },
  ];
  const comments = [
    {
      id: 101,
      issue_url: `${baseIssueUrl}/1`,
      body: envelope,
      user: { id: 1775584, login: 'iteathen' },
      created_at: '2026-08-18T10:00:00Z',
      updated_at: '2026-08-18T10:00:00Z',
    },
    {
      id: 102,
      issue_url: `${baseIssueUrl}/2`,
      body: envelope,
      user: { id: 1775584, login: 'iteathen' },
      created_at: '2026-08-18T10:01:00Z',
      updated_at: '2026-08-18T10:02:00Z',
    },
  ];
  const source = new IssueTaskSource({
    client: clientFor(issues, comments),
    queueRepository: 'iteathen/PATCH-POLLER',
    taskLabel: 'patch-poller:ready',
    trustedActorIds: ['1775584']
  });
  const result = await source.poll();

  assert.equal(result.tasks.length, 1);
  const task = result.tasks[0];
  assert.equal(task.issueNumber, 1);
  assert.equal(task.actorId, '1775584');
  assert.match(task.revision, /^[0-9a-f]{64}$/u);
  assert.match(task.envelopeRevision, /^[0-9a-f]{64}$/u);
  assert.notEqual(task.revision, task.envelopeRevision);
  assert.deepEqual(task.authority, {
    kind: 'github-issue-comment',
    issueId: '1',
    issueNumber: 1,
    commentId: '101',
    actorId: '1775584',
    actorLogin: 'iteathen',
    createdAt: '2026-08-18T10:00:00Z',
    bodySha256: task.authority.bodySha256,
    edited: false,
  });
  assert.match(task.authority.bodySha256, /^[0-9a-f]{64}$/u);

  assert.deepEqual(result.rejected.map((entry) => [entry.issueNumber, entry.reason]), [
    [2, 'edited-authority-comment'],
    [4, 'missing-trusted-authority-comment'],
  ]);
});

test('quoted or untrusted task blocks never become machine authority', async () => {
  const issues = [{ id: 9, number: 9, title: 'discussion', body: '', user: { id: 1775584 } }];
  const comments = [
    {
      id: 901,
      issue_url: `${baseIssueUrl}/9`,
      body: `> ${envelope.replaceAll('\n', '\n> ')}`,
      user: { id: 1775584, login: 'iteathen' },
      created_at: '2026-08-18T11:00:00Z',
      updated_at: '2026-08-18T11:00:00Z',
    },
    {
      id: 902,
      issue_url: `${baseIssueUrl}/9`,
      body: envelope,
      user: { id: 999, login: 'untrusted' },
      created_at: '2026-08-18T11:01:00Z',
      updated_at: '2026-08-18T11:01:00Z',
    },
  ];
  const source = new IssueTaskSource({
    client: clientFor(issues, comments),
    queueRepository: 'iteathen/PATCH-POLLER',
    taskLabel: 'patch-poller:ready',
    trustedActorIds: ['1775584']
  });
  const result = await source.poll();
  assert.equal(result.tasks.length, 0);
  assert.equal(result.rejected[0].reason, 'missing-trusted-authority-comment');
});
