import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessRunner, parseResultJsonText, toolBridge } from '../src/runtime/process-runner.js';
import {
  WorkerExchange,
  WORKER_CONTEXT_FILE,
  WORKER_RESULT_FILE,
} from '../src/runtime/worker-exchange.js';

const profile = {
  name: 'node-fixture',
  executable: process.execPath,
  args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);console.log(x.objective);console.log(process.env.SHOULD_NOT_PASS||"clean");console.log(process.env.GH_TOKEN||"clean-github")})'],
  inputMode: 'stdin-json',
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
  environment: { pass: ['GH_TOKEN'], set: {} },
  sandbox: { enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' }
};

function verifiedTestSandbox() {
  return {
    async prepareExecution({ executable, args, cwd, env, sandbox }) {
      assert.equal(sandbox.required, true);
      assert.equal(sandbox.ipc.contextTarget, WORKER_CONTEXT_FILE);
      assert.equal(sandbox.ipc.resultTarget, WORKER_RESULT_FILE);
      return {
        executable,
        args,
        cwd,
        env,
        evidence: {
          provider: 'test-boundary',
          verified: true,
          verification: 'unit-fixture',
          filesystem: 'test-only',
          network: 'denied',
          gitAdministrativeState: 'read-only-or-unreachable',
          workerIpc: 'control-owned-exact-file-bindings',
        },
      };
    },
  };
}

test('tool bridge tells workers the mandatory result fields and Git authority boundary', () => {
  const bridge = toolBridge('r1', WORKER_RESULT_FILE);
  assert.deepEqual(bridge.resultSchema.required, ['protocol', 'status', 'summary']);
  assert.equal(bridge.resultSchema.protocol, 'patch-poller/result-v1');
  assert.ok(bridge.resultSchema.status.includes('complete'));
  assert.match(bridge.resultSchema.summary, /Required non-empty string/u);
  assert.match(bridge.requirement, /overwrite the existing resultFile in place/u);
  assert.equal(bridge.resultFile, WORKER_RESULT_FILE);
  assert.equal(bridge.gitAuthority.owner, 'patch-poller');
  assert.match(bridge.gitAuthority.rule, /Do not stage, commit, reset/u);
  assert.match(bridge.gitAuthority.rule, /PATCH-POLLER validates, stages, seals, commits, and publishes/u);
  assert.equal(bridge.example.protocol, 'patch-poller/result-v1');
  assert.equal(bridge.example.status, 'complete');
  assert.ok(bridge.example.summary.length > 0);
});

test('accepts a single UTF-8 BOM before otherwise valid tool result JSON', () => {
  const parsed = parseResultJsonText('\uFEFF{"protocol":"patch-poller/result-v1","status":"complete","summary":"ok"}');
  assert.equal(parsed.protocol, 'patch-poller/result-v1');
  assert.equal(parsed.status, 'complete');
  assert.equal(parsed.summary, 'ok');
});

test('worker execution fails closed without a control-owned exchange and verified isolation provider', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-process-runner-closed-'));
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  try {
    const runner = new ProcessRunner();
    await assert.rejects(
      () => runner.run({
        profile,
        projectDir,
        runDir: path.join(projectDir, '.patch-poller', 'r1', 'turn-1'),
        runId: 'r1',
        context: { objective: 'never launch' },
      }),
      /control-plane-owned worker exchange/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runs without a shell, keeps IPC outside the proposal tree, and scrubs control credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-process-runner-'));
  const projectDir = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  await mkdir(projectDir);
  try {
    const exchange = new WorkerExchange({ stateDirectory });
    const runner = new ProcessRunner({
      sourceEnv: { ...process.env, SHOULD_NOT_PASS: 'secret', GH_TOKEN: 'github-secret' },
      workerExchange: exchange,
      sandboxProvider: verifiedTestSandbox(),
    });
    const result = await runner.run({
      profile,
      projectDir,
      runDir: path.join(projectDir, '.patch-poller', 'r1', 'turn-1'),
      runId: 'r1',
      context: { objective: 'hello' }
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello/);
    assert.match(result.stdout, /clean/);
    assert.match(result.stdout, /clean-github/);
    assert.doesNotMatch(result.stdout, /secret/);
    assert.equal(result.workerContextFile, WORKER_CONTEXT_FILE);
    assert.equal(result.workerResultFile, WORKER_RESULT_FILE);
    assert.equal(path.relative(projectDir, result.contextFile).startsWith('..'), true);
    assert.equal(path.relative(projectDir, result.resultFile).startsWith('..'), true);
    assert.equal(result.sandbox.verified, true);
    assert.equal(result.sandbox.workerIpc, 'control-owned-exact-file-bindings');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers an interrupted worker result from the exact control-owned run/turn mailbox without launching a child', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-process-runner-recovery-'));
  const projectDir = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  await mkdir(projectDir);
  try {
    const exchange = new WorkerExchange({ stateDirectory });
    const mailbox = await exchange.prepareTurn({
      runId: 'r1',
      turnId: 'turn-1',
      context: { objective: 'interrupted worker' },
    });
    await writeFile(mailbox.resultFile, `${JSON.stringify({
      protocol: 'patch-poller/result-v1',
      status: 'continue',
      summary: 'recoverable checkpoint result',
      nextStep: 'continue from durable candidate bytes',
    })}\n`, { encoding: 'utf8' });

    const recoveredRunner = new ProcessRunner({
      workerExchange: new WorkerExchange({ stateDirectory }),
    });
    const recovered = await recoveredRunner.recoverResult({
      projectDir,
      runDir: path.join(projectDir, '.patch-poller', 'r1', 'turn-1'),
      runId: 'r1',
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.resultPresent, true);
    assert.equal(recovered.resultParseError, null);
    assert.equal(recovered.result.status, 'continue');
    assert.equal(recovered.result.summary, 'recoverable checkpoint result');
    assert.equal(path.relative(projectDir, recovered.resultFile).startsWith('..'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
