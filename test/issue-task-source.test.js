import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueTaskSource } from '../src/github/issue-task-source.js';

const envelope = `\`\`\`patch-poller-task\n${JSON.stringify({ protocol: 'patch-poller/task-v1', target: { repository: 'iteathen/repo' }, instructions: 'Do work.' })}\n\`\`\``;

test('issue bodies are descriptive and only unedited trusted standalone comments are task authority', async () => {
  const client = {
    rateBudget: { snapshot: () => ({ pollIntervalMs: 60_000 }) },
    request: async (_method, requestPath) => {
      if (requestPath.includes('/issues?')) {
        return {
          notModified: false,
          data: [
            { id: 1, number: 1, title: 'good', body: envelope, user: { id: 999, login: 'body-editor-does-not-matter' } },
            { id: 2, number: 2, title: 'bad actor', body: '', user: { id: 1775584 } },
            { id: 3, number: 3, title: 'edited', body: '', user: { id: 1775584 } },
            { id: 4, number: 4, title: 'pr', body: envelope, user: { id: 1775584 }, pull_request: {} }
          ]
        };
      }
      if (requestPath.includes('/issues/1/comments')) return { notModified: false, data: [{ id: 101, body: envelope, user: { id: 1775584, login: 'iteathen' }, created_at: '2026-08-18T20:00:00Z', updated_at: '2026-08-18T20:00:00Z' }] };
      if (requestPath.includes('/issues/2/comments')) return { notModified: false, data: [{ id: 102, body: envelope, user: { id: 999, login: 'bad' }, created_at: '2026-08-18T20:00:00Z', updated_at: '2026-08-18T20:00:00Z' }] };
      if (requestPath.includes('/issues/3/comments')) return { notModified: false, data: [{ id: 103, body: envelope, user: { id: 1775584, login: 'iteathen' }, created_at: '2026-08-18T20:00:00Z', updated_at: '2026-08-18T20:01:00Z' }] };
      throw new Error(`unexpected request ${requestPath}`);
    }
  };
  const source = new IssueTaskSource({ client, queueRepository: 'iteathen/PATCH-POLLER', taskLabel: 'patch-poller:ready', trustedActorIds: ['1775584'] });
  const result = await source.poll();
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].issueNumber, 1);
  assert.equal(result.tasks[0].authority.commentId, 101);
  assert.equal(result.tasks[0].authority.unedited, true);
  assert.match(result.tasks[0].authority.contentSha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.rejected.some((entry) => entry.reason === 'untrusted-actor' && entry.commentId === 102), true);
  assert.equal(result.rejected.some((entry) => entry.reason === 'edited-authority-content' && entry.commentId === 103), true);
});

test('quoted or discussion-wrapped task blocks are not machine authority', async () => {
  const client = {
    rateBudget: { snapshot: () => ({ pollIntervalMs: 60_000 }) },
    request: async (_method, requestPath) => requestPath.includes('/issues?')
      ? { notModified: false, data: [{ id: 1, number: 1, title: 'discussion', body: '', user: { id: 1775584 } }] }
      : { notModified: false, data: [{ id: 201, body: `Please consider:\n${envelope}`, user: { id: 1775584 }, created_at: '2026-08-18T20:00:00Z', updated_at: '2026-08-18T20:00:00Z' }] }
  };
  const source = new IssueTaskSource({ client, queueRepository: 'iteathen/PATCH-POLLER', taskLabel: 'patch-poller:ready', trustedActorIds: ['1775584'] });
  const result = await source.poll();
  assert.equal(result.tasks.length, 0);
  assert.equal(result.rejected[0].reason, 'invalid-envelope');
});
