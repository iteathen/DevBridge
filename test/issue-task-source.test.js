import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueTaskSource } from '../src/github/issue-task-source.js';

const envelope = `\`\`\`patch-poller-task\n${JSON.stringify({ protocol: 'patch-poller/task-v1', target: { repository: 'iteathen/repo' }, instructions: 'Do work.' })}\n\`\`\``;

test('accepts only trusted issue authors and ignores pull requests', async () => {
  const client = {
    rateBudget: { snapshot: () => ({ pollIntervalMs: 60_000 }) },
    request: async () => ({
      notModified: false,
      data: [
        { id: 1, number: 1, title: 'good', body: envelope, user: { id: 1775584, login: 'iteathen' } },
        { id: 2, number: 2, title: 'bad', body: envelope, user: { id: 999, login: 'bad' } },
        { id: 3, number: 3, title: 'pr', body: envelope, user: { id: 1775584 }, pull_request: {} }
      ]
    })
  };
  const source = new IssueTaskSource({ client, queueRepository: 'iteathen/PATCH-POLLER', taskLabel: 'patch-poller:ready', trustedActorIds: ['1775584'] });
  const result = await source.poll();
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].issueNumber, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'untrusted-actor');
});
