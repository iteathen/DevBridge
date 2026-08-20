import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { composeWorkRunner } from '../src/app/work-runner-composition.js';
import { applyChildProcessPriority, processPriorityValue } from '../src/runtime/process-priority.js';
import {
  REPOSITORY_EXECUTION_RESULT_PROTOCOL,
  REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  normalizeRepositoryExecutionRequest,
} from '../src/runtime/repository-execution.js';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';

const workerProfile = {
  name: 'priority-fixture',
  executable: '/host/executable/not-used-by-repository-execution',
  args: ['--result', '{resultFile}'],
  inputMode: 'stdin-json',
  timeoutMs: 5000,
  maxOutputBytes: 8192,
  environment: { pass: [], set: {} },
  sandbox: { enforcement: 'none', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' },
};

function fakeRepositoryExecution() {
  return {
    inspect() {
      return { protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'priority-fixture', reason: null };
    },
    async execute(raw) {
      const request = normalizeRepositoryExecutionRequest(raw);
      const output = request.transfers.find((entry) => entry.name === 'result');
      await output.port.write(`${JSON.stringify({ protocol: 'devbridge/result-v1', status: 'complete', summary: 'done' })}\n`);
      return {
        protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
        exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false,
        stdout: '', stderr: '', startedAt: null, finishedAt: null, lastOutputAt: null,
        evidence: { identity: 'priority-fixture', scope: request.scope },
      };
    },
  };
}

test('priority mapping uses the platform below-normal and low constants', () => {
  assert.equal(processPriorityValue('below-normal'), os.constants.priority.PRIORITY_BELOW_NORMAL);
  assert.equal(processPriorityValue('low'), os.constants.priority.PRIORITY_LOW);
  assert.throws(() => processPriorityValue('elevated'), /unsupported child process priority/u);
});

test('priority helper applies the exact requested level to the spawned child PID', async () => {
  const calls = [];
  const child = { pid: 43210 };
  const evidence = await applyChildProcessPriority(child, 'below-normal', {
    setPriority: (pid, value) => calls.push([pid, value]),
  });
  assert.deepEqual(calls, [[43210, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
  assert.deepEqual(evidence, {
    level: 'below-normal',
    value: os.constants.priority.PRIORITY_BELOW_NORMAL,
    applied: true,
  });
});

test('trusted host deterministic process runner applies configured priority to the actual child', async () => {
  const calls = [];
  const runner = new DeterministicProcessRunner({
    processPriority: 'below-normal',
    setPriority: (pid, value) => calls.push([pid, value]),
  });
  const result = await runner.run({
    executable: process.execPath,
    args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'],
    cwd: process.cwd(),
    timeoutMs: 5000,
    stdin: 'fixture',
    executionClass: 'control-process',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.ok(Number.isSafeInteger(calls[0][0]) && calls[0][0] > 0);
  assert.equal(calls[0][1], os.constants.priority.PRIORITY_BELOW_NORMAL);
  assert.equal(result.processPriority.applied, true);
  assert.equal(result.execution.location, 'host');
});

test('repository worker execution does not inherit host process-priority mechanics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-priority-worker-'));
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  try {
    const runner = composeWorkRunner({
      mailboxStore: new WorkerExchange({ stateDirectory: path.join(root, 'state') }),
      activeExecution: fakeRepositoryExecution(),
    });
    const result = await runner.run({
      profile: workerProfile,
      projectDir,
      runDir: path.join(projectDir, '.devbridge', 'priority-run', 'turn-1'),
      runId: 'priority-run',
      repository: 'owner/project',
      context: { objective: 'priority fixture' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(Object.hasOwn(result, 'processPriority'), false);
    assert.equal(Object.hasOwn(result, 'execution'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requested host priority failure fails closed instead of silently running at normal priority', async () => {
  const runner = new DeterministicProcessRunner({
    processPriority: 'below-normal',
    setPriority: () => { throw new Error('priority denied'); },
  });
  await assert.rejects(
    runner.run({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: process.cwd(),
      timeoutMs: 5000,
      executionClass: 'control-process',
    }),
    /failed to apply configured child process priority below-normal/u,
  );
});
