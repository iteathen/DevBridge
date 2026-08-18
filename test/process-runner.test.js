import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessRunner, parseResultJsonText, toolBridge } from '../src/runtime/process-runner.js';

const workerScript = String.raw`
const fs = require('node:fs');
let s = '';
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  const x = JSON.parse(s);
  console.log(x.objective);
  console.log(process.env.SHOULD_NOT_PASS || 'clean');
  fs.writeFileSync(x.bridge.resultFile, JSON.stringify({
    protocol: 'patch-poller/result-v1',
    status: 'complete',
    summary: 'worker result through control mailbox'
  }));
});`;

const profile = {
  name: 'node-fixture',
  executable: process.execPath,
  args: ['-e', workerScript],
  inputMode: 'stdin-json',
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
  controlOwned: false,
  environment: { pass: [], set: {} },
  sandbox: { enforcement: 'os', outsideProjectRead: 'deny', readOnlyRoots: [], outsideProjectWrite: false, network: 'deny' }
};

class RecordingSandboxManager {
  requests = [];

  async prepareLaunch(request) {
    this.requests.push(request);
    return {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      sandbox: { provider: 'fixture', configured: true, verified: true }
    };
  }
}

test('tool bridge tells workers the mandatory result fields and Git authority boundary', () => {
  const bridge = toolBridge('r1', '/control/mailboxes/r1/result.json', { mailboxId: 'm1', turn: 1 });
  assert.deepEqual(bridge.resultSchema.required, ['protocol', 'status', 'summary']);
  assert.equal(bridge.resultSchema.protocol, 'patch-poller/result-v1');
  assert.ok(bridge.resultSchema.status.includes('complete'));
  assert.match(bridge.resultSchema.summary, /Required non-empty string/u);
  assert.equal(bridge.gitAuthority.owner, 'patch-poller');
  assert.match(bridge.gitAuthority.rule, /Do not stage, commit, reset/u);
  assert.match(bridge.gitAuthority.rule, /PATCH-POLLER validates, stages, seals, commits, and publishes/u);
  assert.equal(bridge.mailboxId, 'm1');
  assert.equal(bridge.turn, 1);
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

test('routes proposal workers through verified sandbox manager and external control mailbox', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'pp-project-'));
  const mailboxRoot = await mkdtemp(path.join(os.tmpdir(), 'pp-control-mailboxes-'));
  const sandboxManager = new RecordingSandboxManager();
  const runner = new ProcessRunner({
    sourceEnv: { ...process.env, SHOULD_NOT_PASS: 'secret' },
    mailboxRoot,
    sandboxManager,
  });
  const result = await runner.run({
    profile,
    projectDir,
    runId: 'r1',
    turn: 3,
    context: { objective: 'hello' }
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
  assert.match(result.stdout, /clean/);
  assert.doesNotMatch(result.stdout, /secret/);
  assert.equal(result.result?.protocol, 'patch-poller/result-v1');
  assert.equal(result.result?.status, 'complete');
  assert.equal(result.result?.summary, 'worker result through control mailbox');
  assert.equal(result.contextFile, null);
  assert.equal(result.resultFile, null);
  assert.equal(result.sandbox.verified, true);

  assert.equal(sandboxManager.requests.length, 1);
  const request = sandboxManager.requests[0];
  assert.equal(request.projectDir, path.resolve(projectDir));
  assert.equal(request.projectWrite, true);
  assert.equal(request.executionClass, 'repository-code-executing');
  assert.equal(request.readOnlyRoots.length, 1);
  assert.equal(request.writableRoots.length, 1);
  assert.ok(path.relative(projectDir, request.readOnlyRoots[0]).startsWith('..'));
  assert.ok(path.relative(projectDir, request.writableRoots[0]).startsWith('..'));
  assert.ok(request.readOnlyRoots[0].startsWith(path.resolve(mailboxRoot)));
  assert.ok(request.writableRoots[0].startsWith(path.resolve(mailboxRoot)));
  assert.equal(request.env.SHOULD_NOT_PASS, undefined);
});
