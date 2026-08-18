import test from 'node:test';
import assert from 'node:assert/strict';
import { reportActiveRunRuntimeError } from '../src/app/runtime-error-report.js';

function state(stage = 'waiting-feedback') {
  return {
    runId: 'pp-4-abc',
    stage,
    turn: 1,
    createdAt: '2026-08-18T00:00:00.000Z',
    task: {
      queueRepository: 'iteathen/PATCH-POLLER',
      issueNumber: 4,
      actorId: '1775584',
      revision: 'a'.repeat(64),
      envelope: {
        target: { repository: 'iteathen/PATCH-POLLER' },
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
      git: { branch: 'patchpoller/issue-4-abc', baseSha: '1'.repeat(40), headSha: '1'.repeat(40), dirty: true },
      blockers: ['waiting'],
      nextStep: null,
      outputTail: null,
    },
  };
}

test('reports a nonterminal runtime error against the active run', async () => {
  const reports = [];
  const runtime = {
    config: { github: { queueRepository: 'iteathen/PATCH-POLLER' } },
    stateStore: {
      entries: async () => [
        ['run.iteathen/PATCH-POLLER#3.old', state('failed')],
        ['run.iteathen/PATCH-POLLER#4.current', state('waiting-feedback')],
      ],
    },
    statusReporter: {
      publish: async (value) => {
        reports.push(value);
        return { published: true, commentId: 42, sequence: 3 };
      },
    },
  };

  const result = await reportActiveRunRuntimeError(runtime, new Error('boom'));
  assert.equal(result.reported, true);
  assert.equal(result.issueNumber, 4);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].stage, 'RUNTIME_ERROR');
  assert.equal(reports[0].terminal, false);
  assert.equal(reports[0].force, true);
  assert.match(reports[0].summary, /Error: boom/u);
  assert.ok(reports[0].capsule.blockers.some((entry) => /runtime error/u.test(entry)));
});

test('does nothing when there is no active run', async () => {
  const runtime = {
    config: { github: { queueRepository: 'iteathen/PATCH-POLLER' } },
    stateStore: { entries: async () => [['run.x', state('completed')]] },
    statusReporter: { publish: async () => { throw new Error('must not publish'); } },
  };
  const result = await reportActiveRunRuntimeError(runtime, new Error('boom'));
  assert.equal(result.reported, false);
  assert.equal(result.reason, 'no-active-run');
});
