import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ProcessRunner } from '../src/runtime/process-runner.js';
import { createSandboxManager } from '../src/runtime/sandbox-manager.js';

const runRealSandbox = process.platform === 'linux' && process.env.PATCH_POLLER_TEST_REAL_SANDBOX === '1';

function nodeReadRoots() {
  const executable = path.resolve(process.execPath);
  if (['/usr/', '/bin/', '/lib/', '/lib64/'].some((root) => executable.startsWith(root))) return [];
  return [path.dirname(path.dirname(executable))];
}

const workerScript = String.raw`
const fs = require('node:fs');
const net = require('node:net');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const context = JSON.parse(input);
  const denied = (fn) => { try { fn(); return false; } catch { return true; } };
  fs.writeFileSync('proposal.txt', 'proposal');
  const observed = {
    proposalWrite: fs.readFileSync('proposal.txt', 'utf8') === 'proposal',
    gitAdminHidden: denied(() => fs.readFileSync('.git/authority', 'utf8')),
    externalReadDenied: denied(() => fs.readFileSync(process.env.PP_OUTSIDE, 'utf8')),
    credentialAbsent: process.env.GITHUB_TOKEN == null && process.env.GH_TOKEN == null,
    networkDenied: await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: Number(process.env.PP_PORT) });
      const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 750);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
      socket.once('error', () => { clearTimeout(timer); resolve(true); });
    })
  };
  fs.writeFileSync(context.bridge.resultFile, JSON.stringify({
    protocol: 'patch-poller/result-v1',
    status: 'complete',
    summary: 'real sandbox boundary probe',
    tests: [observed]
  }));
});`;

test('bubblewrap boundary denies network, control state, git admin, and credentials while allowing proposal writes', { skip: !runRealSandbox }, async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'pp-real-sandbox-project-'));
  const controlRoot = await mkdtemp(path.join(os.tmpdir(), 'pp-real-sandbox-control-'));
  await mkdir(path.join(projectDir, '.git'), { mode: 0o700 });
  await writeFile(path.join(projectDir, '.git', 'authority'), 'git-admin', { mode: 0o600 });
  const outsideFile = path.join(controlRoot, 'control-secret.txt');
  await writeFile(outsideFile, 'control-secret', { mode: 0o600 });

  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  try {
    const sandboxManager = createSandboxManager({ provider: 'bubblewrap', executable: 'bwrap' }, { env: process.env });
    const verification = await sandboxManager.inspect({ refresh: true });
    assert.equal(verification.verified, true);
    assert.deepEqual(verification.boundaries, {
      projectRead: true,
      projectWriteDenied: true,
      externalReadDenied: true,
      externalWriteDenied: true,
      gitAdminHidden: true,
      networkDenied: true,
    });

    const profile = {
      name: 'real-sandbox-fixture',
      executable: process.execPath,
      args: ['-e', workerScript],
      inputMode: 'stdin-json',
      timeoutMs: 10_000,
      maxOutputBytes: 128 * 1024,
      controlOwned: false,
      environment: {
        pass: [],
        set: { PP_OUTSIDE: outsideFile, PP_PORT: String(port) }
      },
      sandbox: {
        enforcement: 'os',
        outsideProjectRead: nodeReadRoots().length ? 'allowlist' : 'deny',
        readOnlyRoots: nodeReadRoots(),
        outsideProjectWrite: false,
        network: 'deny'
      }
    };
    const runner = new ProcessRunner({
      sourceEnv: { ...process.env, GITHUB_TOKEN: 'must-not-cross', GH_TOKEN: 'must-not-cross-either' },
      mailboxRoot: path.join(controlRoot, 'mailboxes'),
      sandboxManager,
    });
    const result = await runner.run({ profile, projectDir, runId: 'real-boundary', turn: 1, context: { objective: 'probe' } });

    assert.equal(result.exitCode, 0);
    assert.equal(result.sandbox.verified, true);
    assert.equal(await readFile(path.join(projectDir, 'proposal.txt'), 'utf8'), 'proposal');
    assert.deepEqual(result.result?.tests?.[0], {
      proposalWrite: true,
      gitAdminHidden: true,
      externalReadDenied: true,
      credentialAbsent: true,
      networkDenied: true,
    });
    assert.equal(await readFile(outsideFile, 'utf8'), 'control-secret');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('repository-code execution fails closed without a verified provider', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'pp-no-sandbox-project-'));
  const controlRoot = await mkdtemp(path.join(os.tmpdir(), 'pp-no-sandbox-control-'));
  const runner = new ProcessRunner({ mailboxRoot: path.join(controlRoot, 'mailboxes') });
  const profile = {
    name: 'requires-sandbox',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    inputMode: 'none',
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    controlOwned: false,
    environment: { pass: [], set: {} },
    sandbox: { enforcement: 'os', outsideProjectRead: 'deny', readOnlyRoots: [], outsideProjectWrite: false, network: 'deny' }
  };
  await assert.rejects(
    runner.run({ profile, projectDir, runId: 'no-provider', turn: 1, context: {} }),
    /requires a verified sandbox provider/u,
  );
});
