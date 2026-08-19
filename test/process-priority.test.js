import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { ProcessRunner } from '../src/runtime/process-runner.js';
import { applyChildProcessPriority, processPriorityValue } from '../src/runtime/process-priority.js';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';

function verifiedSandbox() {
  return {
    async prepareExecution({ executable, args, cwd, env }) {
      return {
        executable,
        args,
        cwd,
        env,
        evidence: {
          provider: 'priority-test',
          verified: true,
          verification: 'fixture',
          filesystem: 'test-only',
          network: 'denied',
          gitAdministrativeState: 'read-only-or-unreachable',
        },
      };
    },
  };
}

const workerProfile = {
  name: 'priority-fixture',
  executable: process.execPath,
  args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'],
  inputMode: 'stdin-json',
  timeoutMs: 5000,
  maxOutputBytes: 8192,
  environment: { pass: [], set: {} },
  sandbox: { enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' },
};

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

test('deterministic process runner applies configured priority to the actual child before operation input', async () => {
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
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.ok(Number.isSafeInteger(calls[0][0]) && calls[0][0] > 0);
  assert.equal(calls[0][1], os.constants.priority.PRIORITY_BELOW_NORMAL);
  assert.equal(result.processPriority.applied, true);
});

test('model process runner applies the same configured priority policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-priority-worker-'));
  const projectDir = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  await mkdir(projectDir);
  try {
    const calls = [];
    const runner = new ProcessRunner({
      workerExchange: new WorkerExchange({ stateDirectory }),
      sandboxProvider: verifiedSandbox(),
      processPriority: 'low',
      setPriority: (pid, value) => calls.push([pid, value]),
    });
    const result = await runner.run({
      profile: workerProfile,
      projectDir,
      runDir: path.join(projectDir, '.devbridge', 'priority-run', 'turn-1'),
      runId: 'priority-run',
      context: { objective: 'priority fixture' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.ok(Number.isSafeInteger(calls[0][0]) && calls[0][0] > 0);
    assert.equal(calls[0][1], os.constants.priority.PRIORITY_LOW);
    assert.equal(result.processPriority.level, 'low');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requested priority failure fails closed instead of silently running at normal priority', async () => {
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
    }),
    /failed to apply configured child process priority below-normal/u,
  );
});
