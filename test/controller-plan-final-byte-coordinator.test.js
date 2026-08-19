import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeControllerPlan } from '../src/run/controller-plan.js';
import { ControllerPlanExecutor } from '../src/run/controller-plan-executor.js';
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

test('controller-plan final-byte mismatch fails the run before candidate sealing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-final-byte-seal-'));
  try {
    const plan = normalizeControllerPlan({
      protocol: 'devbridge/controller-plan-v1',
      files: [{ scope: 'persistent', action: 'create', path: 'planned.txt', content: 'authorized\n' }],
      operations: [{ id: 'mutate', operation: 'fixture.mutate', params: {} }],
      assertions: [],
    });
    let sealCalls = 0;
    const snapshot = {
      branch: 'devbridge/issue-25-final-bytes',
      baseSha: '1'.repeat(40),
      headSha: '1'.repeat(40),
      dirty: true,
      changedFiles: ['planned.txt'],
      unmergedFiles: [],
      status: ' M planned.txt',
    };
    const workspaceManager = {
      prepareRun: async (_task, _runId, resume) => ({
        worktreeDir: root,
        branch: snapshot.branch,
        baseRef: resume?.baseRef ?? 'origin/main',
        baseSha: resume?.baseSha ?? snapshot.baseSha,
      }),
      snapshot: async () => structuredClone(snapshot),
      validate: async () => structuredClone(snapshot),
      sealCandidate: async () => {
        sealCalls += 1;
        throw new Error('sealing must be unreachable after byte mismatch');
      },
    };
    const operationRegistry = {
      validate: () => {},
      execute: async (_name, _params, context) => {
        await writeFile(path.join(context.projectDir, 'planned.txt'), 'mutated\n');
        return {
          exitCode: 0,
          timedOut: false,
          outputTruncated: false,
          stdout: '',
          stderr: '',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          lastOutputAt: null,
        };
      },
    };
    const executor = new ControllerPlanExecutor({ operationRegistry, processRunner: null, workspaceManager });
    const task = {
      queueRepository: 'owner/queue',
      issueNumber: 25,
      actorId: '1',
      revision: 'a'.repeat(64),
      envelope: {
        target: { repository: 'owner/repo' },
        instructions: 'apply exact bytes',
        controllerPlan: plan,
        context: { constraints: [] },
      },
    };
    const store = new MemoryStore();
    const coordinator = new RunCoordinator({
      stateStore: store,
      workspaceManager,
      processRunner: null,
      controllerPlanExecutor: executor,
      queueRepository: 'owner/queue',
      tools: {},
      controllerPlansEnabled: true,
      modelAdaptersEnabled: false,
    });

    const result = await coordinator.executeTask(task);
    assert.equal(result.status, 'failed');
    assert.match(result.error.message, /persistent create target SHA-256 differs from the plan/u);
    assert.equal(sealCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
