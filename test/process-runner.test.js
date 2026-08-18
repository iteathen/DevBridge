import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessRunner, toolBridge } from '../src/runtime/process-runner.js';

const profile = {
  name: 'node-fixture',
  executable: process.execPath,
  args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);console.log(x.objective);console.log(process.env.SHOULD_NOT_PASS||"clean")})'],
  inputMode: 'stdin-json',
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
  environment: { pass: [], set: {} },
  sandbox: { enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' }
};

test('tool bridge tells workers the mandatory result fields', () => {
  const bridge = toolBridge('r1', '/project/.patch-poller/r1/result.json');
  assert.deepEqual(bridge.resultSchema.required, ['protocol', 'status', 'summary']);
  assert.equal(bridge.resultSchema.protocol, 'patch-poller/result-v1');
  assert.ok(bridge.resultSchema.status.includes('complete'));
  assert.match(bridge.resultSchema.summary, /Required non-empty string/u);
  assert.equal(bridge.example.protocol, 'patch-poller/result-v1');
  assert.equal(bridge.example.status, 'complete');
  assert.ok(bridge.example.summary.length > 0);
});

test('runs without a shell, uses bounded context stdin, and scrubs environment', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'pp-project-'));
  const runner = new ProcessRunner({ sourceEnv: { ...process.env, SHOULD_NOT_PASS: 'secret' } });
  const result = await runner.run({
    profile,
    projectDir,
    runDir: path.join(projectDir, '.patch-poller', 'r1'),
    runId: 'r1',
    context: { objective: 'hello' }
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
  assert.match(result.stdout, /clean/);
  assert.doesNotMatch(result.stdout, /secret/);
});
