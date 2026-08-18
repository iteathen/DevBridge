import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessRunner } from '../src/runtime/process-runner.js';

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
