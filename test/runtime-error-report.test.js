import test from 'node:test';
import assert from 'node:assert/strict';
import { reportActiveRunRuntimeError, reportTaskRuntimeError } from '../src/app/runtime-error-report.js';

function state(stage = 'waiting-feedback') {
  return {
    runId: `pp-4-${'a'.repeat(16)}`,
    stage,
    turn: 1,
    createdAt: '2026-08-18T00:00:00.000Z',
    task: {
      queueRepository: 'iteathen/DevBridge',
      issueNumber: 4,
      actorId: '1775584',
      revision: 'a'.repeat(64),
      envelope: {
        target: { repository: 'iteathen/DevBridge' },
        instructions: 'do it',
        requestedCapabilities: [],
        preferredTool: 'fixture',
        context: { summary: 'test', constraints: [] },
      },
    },
    prior: {
      summary: 'test',
      decisions: [],
      progress: [],
      changedFiles: ['a.txt'],
      tests: [],
      git: { branch: 'devbridge/issue-4-abc', baseSha: '1'.repeat(40), headSha: '1'.repeat(40), dirty: true },
      blockers: ['waiting'],
      nextStep: null,
      outputTail: null,
    },
  };
}

test('reports a nonterminal runtime error against the active run', async () => {
  const reports = [];
  const runtime = {
    config: { github: { queueRepositories: ['iteathen/DevBridge'] } },
    queueRepository: 'iteathen/DevBridge',
    stateStore: {
      get: async () => state('waiting-feedback'),
      entries: async () => [
        ['run.iteathen/DevBridge#3.old', state('failed')],
        ['run.iteathen/DevBridge#4.current', state('waiting-feedback')],
      ],
    },
    statusReporter: {
      publish: async (value) => {
        reports.push(value);
        return { published: true, commentId: 42, sequence: 3 };
      },
    },
  };

  const result = await reportTaskRuntimeError(runtime, state().task, new Error('boom'));
  assert.equal(result.reported, true);
  assert.equal(result.issueNumber, 4);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].stage, 'RUNTIME_ERROR');
  assert.equal(reports[0].terminal, false);
  assert.equal(reports[0].force, true);
  assert.match(reports[0].summary, /Error: boom/u);
  assert.ok(reports[0].capsule.blockers.some((entry) => /runtime error/u.test(entry)));
});

test('unattributed collection errors never select an unfinished task', async () => {
  const runtime = {
    config: { github: { queueRepositories: ['iteathen/DevBridge'] } },
    queueRepository: 'iteathen/DevBridge',
    stateStore: { entries: async () => [['run.x', state('waiting-feedback')]] },
    statusReporter: { publish: async () => { throw new Error('must not publish'); } },
  };
  const result = await reportActiveRunRuntimeError(runtime, new Error('boom'));
  assert.equal(result.reported, false);
  assert.equal(result.reason, 'task-correlation-unavailable');
});

test('explicit runtime reporting refuses cross-queue and stale task correlation', async () => {
  const runtime = { queueRepository: 'iteathen/DevBridge', stateStore: { get: async () => state() }, statusReporter: { publish: async () => { throw new Error('must not publish'); } } };
  assert.equal((await reportTaskRuntimeError(runtime, { ...state().task, queueRepository: 'another/repo' }, new Error('boom'))).reported, false);
  assert.equal((await reportTaskRuntimeError(runtime, { ...state().task, revision: 'b'.repeat(64) }, new Error('boom'))).reported, false);
});
