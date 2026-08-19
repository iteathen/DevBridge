import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateRuntimeCandidate } from '../src/bootstrap/candidate-validator.mjs';

function quoted(value) { return JSON.stringify(String(value)); }

const noOpPreflight = 'process.exitCode = 0;\n';

function maliciousTest({ secretFile, currentFile, activationFile }) {
  return `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';

function denied(action) {
  try { action(); return false; } catch { return true; }
}

function networkDenied() {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '1.1.1.1', port: 53 });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    socket.setTimeout(750, () => finish(true));
  });
}

test('malicious validation stays outside supervisor authority', async () => {
  assert.equal(denied(() => fs.readFileSync(${quoted(secretFile)}, 'utf8')), true);
  assert.equal(denied(() => fs.writeFileSync(${quoted(secretFile)}, 'stolen')), true);
  assert.equal(denied(() => fs.readFileSync(${quoted(currentFile)}, 'utf8')), true);
  assert.equal(denied(() => fs.writeFileSync(${quoted(currentFile)}, 'mutated')), true);
  assert.equal(denied(() => fs.writeFileSync(${quoted(activationFile)}, '{"owned":true}')), true);
  assert.equal(process.env.PATCH_POLLER_BOOTSTRAP_SECRET, undefined);
  assert.equal(process.env.GH_TOKEN, undefined);
  assert.equal(process.env.GITHUB_TOKEN, undefined);
  assert.equal(await networkDenied(), true);
});
`;
}

test('candidate validation cannot read/write bootstrap state or reach the network', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-bootstrap-candidate-sandbox-'));
  const home = path.join(root, 'home');
  const runtimeCandidates = path.join(home, 'runtime-candidates');
  const candidateDir = path.join(runtimeCandidates, 'a'.repeat(40));
  const currentDir = path.join(home, 'runtime');
  const secretFile = path.join(home, 'control-secret.txt');
  const currentFile = path.join(currentDir, 'current-runtime.txt');
  const activationFile = path.join(home, 'runtime-activation.json');
  await mkdir(path.join(candidateDir, 'src', 'bootstrap'), { recursive: true });
  await mkdir(path.join(candidateDir, 'test'), { recursive: true });
  await mkdir(currentDir, { recursive: true });
  await writeFile(path.join(candidateDir, 'src', 'bootstrap', 'repository-preflight.mjs'), noOpPreflight);
  await writeFile(path.join(candidateDir, 'test', 'malicious.test.js'), maliciousTest({ secretFile, currentFile, activationFile }));
  await writeFile(secretFile, 'control-secret-sentinel\n');
  await writeFile(currentFile, 'current-runtime-sentinel\n');
  await writeFile(activationFile, '{"protocol":"patch-poller/runtime-activation-v1"}\n');

  const paths = { home, runtimeCandidates };
  const runtime = { runtimeDir: candidateDir, head: 'a'.repeat(40), version: '0.1.0' };
  const sourceEnv = {
    ...process.env,
    PATCH_POLLER_BOOTSTRAP_SECRET: 'must-never-reach-candidate',
    GH_TOKEN: 'must-never-reach-candidate',
    GITHUB_TOKEN: 'must-never-reach-candidate',
  };

  if (process.platform !== 'linux') {
    await assert.rejects(
      () => validateRuntimeCandidate(paths, runtime, null, { env: sourceEnv }),
      /verified OS sandbox provider/u,
    );
    return;
  }

  let validation;
  try {
    validation = await validateRuntimeCandidate(paths, runtime, null, { env: sourceEnv });
  } catch (error) {
    if (process.env.PATCH_POLLER_REQUIRE_SANDBOX_TEST === '1') throw error;
    t.skip(`verified bootstrap candidate sandbox unavailable on this host: ${error.message}`);
    return;
  }
  assert.equal(validation.preflight, 'passed-sandboxed');
  assert.equal(validation.tests, 'passed-sandboxed');
  assert.equal(validation.doctor, 'deferred-post-activation');
  assert.equal(validation.sandbox.verified, true);
  assert.equal(validation.sandbox.network, 'denied');
  assert.equal(await readFile(secretFile, 'utf8'), 'control-secret-sentinel\n');
  assert.equal(await readFile(currentFile, 'utf8'), 'current-runtime-sentinel\n');
  assert.equal(await readFile(activationFile, 'utf8'), '{"protocol":"patch-poller/runtime-activation-v1"}\n');
});
