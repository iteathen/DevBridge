import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { composeWorkRunner } from '../src/app/work-runner-composition.js';
import {
  REPOSITORY_EXECUTION_RESULT_PROTOCOL,
  REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  UnavailableRepositoryExecution,
  normalizeRepositoryExecutionRequest,
} from '../src/runtime/repository-execution.js';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';
import { emitResult } from '../src/runtime/result-emission.js';

const profile = {
  name: 'fixture-action',
  executable: '/host/path/must-not-cross-boundary',
  args: ['--context', '{contextFile}', '--result', '{resultFile}', '--run', '{runId}'],
  inputMode: 'stdin-json',
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
  environment: { pass: ['GH_TOKEN'], set: { FIXTURE: '1' } },
};

function fakeExecution(observed = []) {
  return {
    inspect() { return { protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'fake', reason: null }; },
    async execute(raw) {
      const request = normalizeRepositoryExecutionRequest(raw);
      observed.push(request);
      const input = request.transfers.find((entry) => entry.direction === 'input');
      const output = request.transfers.find((entry) => entry.direction === 'output');
      const context = JSON.parse((await input.port.read()).toString('utf8'));
      await output.port.write(`${JSON.stringify({ protocol: 'devbridge/result-v1', status: 'complete', summary: `completed ${context.objective}` })}\n`);
      return {
        protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
        exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false,
        stdout: 'observed\n', stderr: '', startedAt: null, finishedAt: null, lastOutputAt: null,
        evidence: { identity: 'fake', scope: request.scope },
      };
    },
  };
}

test('composition temporarily maps mailbox and execution topology without leaking it in results', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-work-composition-'));
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  try {
    const observed = [];
    const runner = composeWorkRunner({
      mailboxStore: new WorkerExchange({ stateDirectory: path.join(root, 'state') }),
      activeExecution: fakeExecution(observed),
    });
    const result = await runner.run({
      profile, projectDir, runDir: path.join(projectDir, '.devbridge', 'r1', 'turn-1'), runId: 'r1',
      repository: 'owner/project', repositoryId: '42', context: { objective: 'hello' },
    });
    assert.equal(result.result.status, 'complete');
    assert.match(result.result.summary, /hello/u);
    assert.equal(Object.keys(result).some((name) => /file|path|mailbox|control|execution/iu.test(name)), false);
    assert.equal(observed[0].invocation.tool, 'fixture-action');
    assert.equal(observed[0].invocation.arguments[1].kind, 'input');
    assert.equal(observed[0].invocation.arguments[3].kind, 'output');
    assert.deepEqual(observed[0].invocation.arguments[5], { kind: 'literal', value: 'r1' });
    assert.doesNotMatch(JSON.stringify(observed[0].invocation), /host\/path/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('composition maps the neutral emitted-result action onto the temporary output port', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-work-emission-'));
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  try {
    const activeExecution = {
      inspect: () => ({ protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'fake', reason: null }),
      async execute(raw) {
        const request = normalizeRepositoryExecutionRequest(raw);
        let stdout = 'diagnostic\n';
        emitResult({ protocol: 'devbridge/result-v1', status: 'complete', summary: 'emitted' }, (value) => { stdout += value; });
        return {
          protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
          exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false,
          stdout, stderr: '', startedAt: null, finishedAt: null, lastOutputAt: null,
          evidence: { identity: 'fake', scope: request.scope },
        };
      },
    };
    const runner = composeWorkRunner({ mailboxStore: new WorkerExchange({ stateDirectory: path.join(root, 'state') }), activeExecution });
    const result = await runner.run({
      profile: { ...profile, args: [] }, projectDir, runDir: path.join(projectDir, '.devbridge', 'r1', 'turn-1'),
      runId: 'r1', repository: 'owner/project', context: {},
    });
    assert.equal(result.result.summary, 'emitted');
    assert.equal(result.stdout, 'diagnostic\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('composition fails before input publication when execution is unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-work-unavailable-'));
  const projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  try {
    const runner = composeWorkRunner({
      mailboxStore: new WorkerExchange({ stateDirectory: path.join(root, 'state') }),
      activeExecution: new UnavailableRepositoryExecution({ reason: 'no route' }),
    });
    await assert.rejects(runner.run({
      profile, projectDir, runDir: path.join(projectDir, '.devbridge', 'r1', 'turn-1'), runId: 'r1',
      repository: 'owner/project', context: {},
    }), /no route/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('composition recovers durable output without execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-work-recovery-'));
  const projectDir = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  await mkdir(projectDir);
  try {
    const exchange = new WorkerExchange({ stateDirectory });
    const mailbox = await exchange.prepareTurn({ runId: 'r1', turnId: 'turn-1', context: { objective: 'interrupted' } });
    await writeFile(mailbox.resultFile, '{"protocol":"devbridge/result-v1","status":"continue","summary":"recoverable"}\n');
    const runner = composeWorkRunner({ mailboxStore: new WorkerExchange({ stateDirectory }), activeExecution: fakeExecution() });
    const recovered = await runner.recoverResult({ projectDir, runDir: path.join(projectDir, '.devbridge', 'r1', 'turn-1'), runId: 'r1' });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.result.status, 'continue');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
