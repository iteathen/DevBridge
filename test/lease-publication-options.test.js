import test from 'node:test';
import assert from 'node:assert/strict';
import { LeaseExecutionContext } from '../src/run/lease-execution-context.js';

const VERIFIED_HEAD = 'a'.repeat(40);

test('lease-aware workspace publication forwards the exact verified-head option unchanged', async () => {
  const usabilityChecks = [];
  const leaseHandle = {
    fenced: false,
    onFence() {
      return () => {};
    },
    async assertUsable(options = {}) {
      usabilityChecks.push(structuredClone(options));
      return { state: 'active' };
    }
  };
  const publicationCalls = [];
  const workspaceManager = {
    async publishTaskBranch(workspace, options = {}) {
      publicationCalls.push({ workspace: structuredClone(workspace), options: structuredClone(options) });
      return { branch: workspace.branch, headSha: options.expectedHeadSha };
    }
  };
  const context = new LeaseExecutionContext({ leaseHandle });
  const wrapped = context.wrapWorkspaceManager(workspaceManager);
  const workspace = { branch: 'patchpoller/issue-49-fixture' };

  const result = await wrapped.publishTaskBranch(workspace, { expectedHeadSha: VERIFIED_HEAD });

  assert.deepEqual(publicationCalls, [{
    workspace,
    options: { expectedHeadSha: VERIFIED_HEAD }
  }]);
  assert.deepEqual(usabilityChecks, [{ renew: true }, {}]);
  assert.equal(result.headSha, VERIFIED_HEAD);
  context.close();
});
