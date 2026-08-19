import test from 'node:test';
import assert from 'node:assert/strict';
import { GitWorkspaceManager } from '../src/git/workspace-manager.js';

const REVISION = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const TASK = { issueNumber: 49, revision: REVISION };

function manager(branchPrefix) {
  return new GitWorkspaceManager({
    workspacePolicy: {},
    gitClient: {},
    branchPrefix,
  });
}

test('coordination branch prefix places the full agent fingerprint before the issue segment', () => {
  const branch = manager(`devbridge/${FINGERPRINT}`).branchName(TASK);
  assert.equal(branch, `devbridge/${FINGERPRINT}/issue-49-${REVISION.slice(0, 12)}`);
  assert.equal(branch.includes(FINGERPRINT), true);
});

test('legacy branch prefix remains unchanged when coordination is disabled', () => {
  assert.equal(
    manager('devbridge').branchName(TASK),
    `devbridge/issue-49-${REVISION.slice(0, 12)}`,
  );
});
