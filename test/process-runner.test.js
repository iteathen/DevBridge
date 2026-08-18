import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessRunner, parseResultJsonText, toolBridge } from '../src/runtime/process-runner.js';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';

const profile = {
  name: 'node-fixture',
  executable: process.execPath,
  args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);console.log(x.objective);console.log(process.env.SHOULD_NOT_PASS||"clean")})'],
  inputMode: 'stdin-json',
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
  environment: { pass: [], set: {} },
  sandbox: { declaredEnforcement: 'none', requiresVerifiedSandbox: true, outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' }
};

function verifiedSandbox(observed = []) {
  return {
    inspect: () => ({ provider: 'test-verified', configured: true, verified: true, verification: 'fixture' }),
    prepareSpawn: async ({ executable, args, cwd, environment, sandbox }) => {
      observed.push(structuredClone(sandbox));
      return { executable, args, cwd, environment, provider: 'test-verified' };
    },
  };
}

test('tool bridge tells workers the mandatory result fields and Git authority boundary', () => {
  const bridge = toolBridge('r1', '/control/exchange/result.json');
  assert.deepEqual(bridge.resultSchema.required, ['protocol', 'status', 'summary']);
  assert.equal(bridge.resultSchema.protocol, 'patch-poller/result-v1');
  assert.ok(bridge.resultSchema.status.includes('complete'));
  assert.match(bridge.resultSchema.summary, /Required non-empty string/u);
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

test('proposal execution fails closed without verified containment', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'pp-project-'));
  const controlDir = await mkdtemp(path.join(os.tmpdir(), 'pp-control-'));
  try {
    const runner = new ProcessRunner({ workerExchange: new WorkerExchange({ root: path.join(controlDir, 'exchange') }) });
    await assert.rejects(runner.run({ profile, projectDir, runId: 'r1', turnId: 't1', context: { objective: 'hello' } }), /requires verified containment/u);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});

test('runs through verified containment, keeps IPC outside project, and scrubs environment', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'pp-project-'));
  const controlDir = await mkdtemp(path.join(os.tmpdir(), 'pp-control-'));
  const observed = [];
  try {
    const runner = new ProcessRunner({
      sourceEnv: { ...process.env, SHOULD_NOT_PASS: 'secret' },
      sandboxProvider: verifiedSandbox(observed),
      workerExchange: new WorkerExchange({ root: path.join(controlDir, 'exchange') }),
    });
    const result = await runner.run({
      profile,
      projectDir,
      runId: 'r1',
      turnId: 'turn-1',
      context: { objective: 'hello' }
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello/);
    assert.match(result.stdout, /clean/);
    assert.doesNotMatch(result.stdout, /secret/);
    assert.equal(result.sandboxProvider, 'test-verified');
    assert.equal(observed.length, 1);
    assert.equal(observed[0].projectWritable, true);
    assert.equal(observed[0].network, 'deny');
    assert.equal(path.resolve(result.resultFile).startsWith(path.resolve(projectDir) + path.sep), false);
    assert.equal(path.resolve(result.resultFile).startsWith(path.resolve(controlDir) + path.sep), true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});
