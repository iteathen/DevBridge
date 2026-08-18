import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateCandidateRuntime } from '../src/bootstrap/candidate-validator.mjs';

class FakeSandboxManager {
  constructor(verified = true) { this.verified = verified; this.requests = []; }
  async inspect() {
    return {
      provider: 'fixture-sandbox', configured: true, available: this.verified, verified: this.verified,
      reason: this.verified ? null : 'fixture-unverified', boundaries: this.verified ? { networkDenied: true } : null,
    };
  }
  async prepareLaunch(request) {
    this.requests.push(request);
    return {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      sandbox: { provider: 'fixture-sandbox', verified: true }
    };
  }
}

test('candidate tests and doctor are launched only through the verified sandbox', async () => {
  const candidateDir = await mkdtemp(path.join(os.tmpdir(), 'pp-candidate-validator-'));
  const sandboxManager = new FakeSandboxManager(true);
  const runnerCalls = [];
  const runner = (executable, args, options) => {
    runnerCalls.push({ executable, args, options });
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  let preflightCalls = 0;
  const result = await validateCandidateRuntime({
    candidateDir,
    runner,
    sandboxManager,
    preflightFn: () => { preflightCalls += 1; return { staticOnly: true, syntaxFiles: 1, jsonFiles: 1, targetedTests: 0 }; },
  });

  assert.equal(preflightCalls, 1);
  assert.equal(result.tests, 'passed');
  assert.equal(result.doctor, 'passed');
  assert.equal(result.sandbox.verified, true);
  assert.equal(sandboxManager.requests.length, 2);
  assert.equal(runnerCalls.length, 2);
  for (const request of sandboxManager.requests) {
    assert.equal(request.executionClass, 'repository-code-executing');
    assert.equal(request.projectWrite, false);
    assert.equal(request.projectDir, path.resolve(candidateDir));
    assert.equal(request.writableRoots.length, 1);
  }
});

test('unverified bootstrap sandbox prevents all candidate code execution', async () => {
  const candidateDir = await mkdtemp(path.join(os.tmpdir(), 'pp-candidate-validator-deny-'));
  const sandboxManager = new FakeSandboxManager(false);
  let runnerCalled = false;
  let preflightCalled = false;
  await assert.rejects(validateCandidateRuntime({
    candidateDir,
    sandboxManager,
    runner: () => { runnerCalled = true; return { status: 0 }; },
    preflightFn: () => { preflightCalled = true; return {}; },
  }), /requires a verified bootstrap sandbox/u);
  assert.equal(runnerCalled, false);
  assert.equal(preflightCalled, false);
});
