import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessRunner, parseResultJsonText, toolBridge } from '../src/runtime/process-runner.js';
import {
  REPOSITORY_EXECUTION_RESULT_PROTOCOL,
  REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  normalizeRepositoryExecutionRequest,
} from '../src/runtime/repository-execution.js';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';

const profile = {
  name: 'fixture-worker',
  executable: '/host/path/must-not-cross-boundary',
  args: ['--context', '{contextFile}', '--result', '{resultFile}', '--run', '{runId}'],
  inputMode: 'stdin-json',
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
  environment: { pass: ['GH_TOKEN'], set: { FIXTURE: '1' } },
  sandbox: { enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' },
};

function fakeExecution(observed = []) {
  return {
    inspect() { return { protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'fake', reason: null }; },
    async execute(raw) {
      const request = normalizeRepositoryExecutionRequest(raw);
      observed.push(request);
      const contextTransfer = request.transfers.find((entry) => entry.direction === 'input');
      const resultTransfer = request.transfers.find((entry) => entry.direction === 'output');
      const contextText = (await contextTransfer.port.read()).toString('utf8');
      const context = JSON.parse(contextText);
      await resultTransfer.port.write(`${JSON.stringify({
        protocol: 'devbridge/result-v1',
        status: 'complete',
        summary: `fake completed ${context.objective}`,
      })}\n`);
      return {
        protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
        exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false,
        stdout: 'fake stdout\n', stderr: '', startedAt: null, finishedAt: null, lastOutputAt: null,
        evidence: { identity: 'fake', scope: request.scope },
      };
    },
  };
}

test('tool bridge describes logical result transfer and host Git authority', () => {
  const bridge = toolBridge('r1');
  assert.equal(bridge.protocol, 'devbridge/tool-bridge-v2');
  assert.equal(bridge.resultTransfer, 'result');
  assert.deepEqual(bridge.resultSchema.required, ['protocol', 'status', 'summary']);
  assert.match(bridge.requirement, /output transfer named result/u);
  assert.doesNotMatch(JSON.stringify(bridge), /\/run\/|resultFile|sandbox/u);
  assert.equal(bridge.gitAuthority.owner, 'devbridge');
});

test('accepts a single UTF-8 BOM before otherwise valid tool result JSON', () => {
  const parsed = parseResultJsonText('\uFEFF{"protocol":"devbridge/result-v1","status":"complete","summary":"ok"}');
  assert.equal(parsed.status, 'complete');
});

test('worker execution fails closed before mailbox creation when repository execution is unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-worker-closed-'));
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  try {
    const exchange = new WorkerExchange({ stateDirectory: path.join(root, 'state') });
    const runner = new ProcessRunner({ workerExchange: exchange });
    await assert.rejects(() => runner.run({
      profile, projectDir, runDir: path.join(projectDir, '.devbridge', 'r1', 'turn-1'), runId: 'r1',
      repository: 'owner/project', context: { objective: 'never execute' },
    }), /no repository execution implementation/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker runner uses only repository-execution studs and never exports host executable or host env inheritance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-worker-fake-'));
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  try {
    const observed = [];
    const runner = new ProcessRunner({
      workerExchange: new WorkerExchange({ stateDirectory: path.join(root, 'state') }),
      repositoryExecution: fakeExecution(observed),
    });
    const result = await runner.run({
      profile, projectDir, runDir: path.join(projectDir, '.devbridge', 'r1', 'turn-1'), runId: 'r1',
      repository: 'owner/project', repositoryId: '42', context: { objective: 'hello' },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.result.status, 'complete');
    assert.match(result.result.summary, /hello/u);
    assert.equal(result.execution.identity, 'fake');
    assert.equal(observed.length, 1);
    const request = observed[0];
    assert.equal(request.invocation.tool, 'fixture-worker');
    assert.equal(request.invocation.arguments[1].kind, 'input');
    assert.equal(request.invocation.arguments[3].kind, 'output');
    assert.deepEqual(request.invocation.arguments[5], { kind: 'literal', value: 'r1' });
    assert.equal(request.environment.FIXTURE, '1');
    assert.equal(request.environment.GH_TOKEN, undefined);
    assert.doesNotMatch(JSON.stringify(request.invocation), /host\/path/u);
    assert.equal(path.relative(projectDir, result.controlResultFile).startsWith('..'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovers an interrupted result from exact control-owned run/turn exchange without execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-worker-recovery-'));
  const projectDir = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  await mkdir(projectDir);
  try {
    const exchange = new WorkerExchange({ stateDirectory });
    const mailbox = await exchange.prepareTurn({ runId: 'r1', turnId: 'turn-1', context: { objective: 'interrupted' } });
    await writeFile(mailbox.resultFile, `${JSON.stringify({ protocol: 'devbridge/result-v1', status: 'continue', summary: 'recoverable' })}\n`);
    const recovered = await new ProcessRunner({ workerExchange: new WorkerExchange({ stateDirectory }) }).recoverResult({
      projectDir, runDir: path.join(projectDir, '.devbridge', 'r1', 'turn-1'), runId: 'r1',
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.result.status, 'continue');
    assert.equal(recovered.execution, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
