import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskLeaseLostError } from '../src/errors.js';
import { LeaseExecutionContext } from '../src/run/lease-execution-context.js';

function fixtureManager() {
  const calls = [];
  let fenced = false;
  const manager = {
    calls,
    fence() { fenced = true; },
    assertOwned(handle) {
      calls.push(['assert', handle]);
      if (fenced) throw new TaskLeaseLostError('lease fenced');
      return handle;
    },
    async ensureFresh(handle) {
      calls.push(['fresh', handle]);
      if (fenced) throw new TaskLeaseLostError('lease fenced');
      return { renewed: true };
    },
  };
  return manager;
}

function workspaceDelegate(calls) {
  return {
    async prepareRun(...args) { calls.push(['prepareRun', ...args]); return 'prepared'; },
    async snapshot(...args) { calls.push(['snapshot', ...args]); return 'snapshot'; },
    async validate(...args) { calls.push(['validate', ...args]); return 'validated'; },
    async sealCandidate(...args) { calls.push(['sealCandidate', ...args]); return 'sealed'; },
    async publishTaskBranch(...args) { calls.push(['publishTaskBranch', ...args]); return 'published'; },
  };
}

test('lease process wrapper injects the active abort signal and rejects effects after fencing', async () => {
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const delegateCalls = [];
  const delegate = {
    async run(request) { delegateCalls.push(request); return { ok: true }; },
  };
  const wrapped = context.wrapProcessRunner(delegate);
  const controller = new AbortController();
  const handle = { signal: controller.signal };

  await context.run(handle, async () => {
    const result = await wrapped.run({ operation: 'tool.test' });
    assert.deepEqual(result, { ok: true });
    assert.equal(delegateCalls.length, 1);
    assert.equal(delegateCalls[0].signal, handle.signal);

    manager.fence();
    await assert.rejects(wrapped.run({ operation: 'tool.blocked' }), TaskLeaseLostError);
    assert.equal(delegateCalls.length, 1);
  });
});

test('process wrapper preserves ordinary control-plane calls outside a task lease context', async () => {
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const seen = [];
  const wrapped = context.wrapProcessRunner({ run: async (request) => { seen.push(request); return 'ok'; } });
  const request = { operation: 'control.maintenance' };
  assert.equal(await wrapped.run(request), 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0], request);
  assert.equal(Object.hasOwn(seen[0], 'signal'), false);
});

test('sealing and publication require a fresh lease before the delegate effect', async () => {
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const delegateCalls = [];
  const wrapped = context.wrapWorkspaceManager(workspaceDelegate(delegateCalls));
  const handle = { signal: new AbortController().signal };

  await context.run(handle, async () => {
    assert.equal(await wrapped.validate('workspace'), 'validated');
    assert.equal(await wrapped.sealCandidate('workspace', { revision: 'a'.repeat(64) }), 'sealed');
    assert.equal(await wrapped.publishTaskBranch('workspace'), 'published');
  });

  const order = [
    ...manager.calls.map(([kind]) => kind),
  ];
  assert.equal(manager.calls.filter(([kind]) => kind === 'fresh').length, 2);
  assert.deepEqual(delegateCalls.map(([kind]) => kind), ['validate', 'sealCandidate', 'publishTaskBranch']);
  const firstFresh = manager.calls.findIndex(([kind]) => kind === 'fresh');
  assert.notEqual(firstFresh, -1);
  assert.equal(order.includes('assert'), true);
});

test('lease-aware publication forwards exact verified-head options only after a fresh fence check', async () => {
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const publicationCalls = [];
  const delegate = {
    async prepareRun() { return 'prepared'; },
    async publishTaskBranch(workspace, options) {
      assert.equal(manager.calls.filter(([kind]) => kind === 'fresh').length, 1);
      publicationCalls.push({ workspace, options });
      return { branch: 'devbridge/issue-49-fixture', headSha: options.expectedHeadSha };
    }
  };
  const wrapped = context.wrapWorkspaceManager(delegate);
  const handle = { signal: new AbortController().signal };
  const options = { expectedHeadSha: 'a'.repeat(40) };

  await context.run(handle, async () => {
    const result = await wrapped.publishTaskBranch('workspace', options);
    assert.equal(result.headSha, options.expectedHeadSha);
    assert.equal(publicationCalls.length, 1);
    assert.equal(publicationCalls[0].workspace, 'workspace');
    assert.equal(publicationCalls[0].options, options);

    manager.fence();
    await assert.rejects(
      wrapped.publishTaskBranch('workspace', { expectedHeadSha: 'b'.repeat(40) }),
      TaskLeaseLostError
    );
  });

  assert.equal(publicationCalls.length, 1);
});

test('fenced lease blocks workspace delegate invocation before a new effect starts', async () => {
  const manager = fixtureManager();
  const context = new LeaseExecutionContext({ taskLeaseManager: manager });
  const delegateCalls = [];
  const wrapped = context.wrapWorkspaceManager(workspaceDelegate(delegateCalls));
  const handle = { signal: new AbortController().signal };

  await context.run(handle, async () => {
    manager.fence();
    await assert.rejects(wrapped.prepareRun('task'), TaskLeaseLostError);
    await assert.rejects(wrapped.sealCandidate('workspace'), TaskLeaseLostError);
  });
  assert.deepEqual(delegateCalls, []);
});
