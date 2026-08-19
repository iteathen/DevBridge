import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeterministicSandboxProvider } from '../src/runtime/deterministic-sandbox.js';
import { ProcessRunner } from '../src/runtime/process-runner.js';
import { WorkerExchange, WORKER_CONTEXT_FILE, WORKER_RESULT_FILE } from '../src/runtime/worker-exchange.js';

const workerFixture = String.raw`
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const context = JSON.parse(input);
  const contextFile = process.argv[2];
  const resultFile = context.bridge.resultFile;
  const [stateRead, stateWrite, daemonRead, credentialRead, controlResult] = process.argv.slice(3);

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

  const observations = {
    stateReadDenied: denied(() => fs.readFileSync(stateRead, 'utf8')),
    stateWriteDenied: denied(() => fs.writeFileSync(stateWrite, 'escaped')),
    daemonReadDenied: denied(() => fs.readFileSync(daemonRead, 'utf8')),
    credentialReadDenied: denied(() => fs.readFileSync(credentialRead, 'utf8')),
    gitWriteDenied: denied(() => fs.writeFileSync(path.join(process.cwd(), '.git', 'config'), 'mutated')),
    contextWriteDenied: denied(() => fs.writeFileSync(contextFile, 'tampered')),
    controlResultReadDenied: denied(() => fs.readFileSync(controlResult, 'utf8')),
    controlResultWriteDenied: denied(() => fs.writeFileSync(controlResult, 'tampered')),
    controlResultUnlinkDenied: denied(() => fs.unlinkSync(controlResult)),
    resultParentWriteDenied: denied(() => fs.writeFileSync(path.join(path.dirname(resultFile), 'sibling-escape.txt'), 'escaped')),
    runtimeWriteDenied: denied(() => fs.writeFileSync(process.argv[1], 'mutated-runtime')),
    networkDenied: await networkDenied(),
    ghTokenAbsent: process.env.GH_TOKEN === undefined,
    githubTokenAbsent: process.env.GITHUB_TOKEN === undefined,
  };

  fs.writeFileSync(path.join(process.cwd(), 'worker-project-write.txt'), 'project-ok\n');
  fs.writeFileSync(resultFile, JSON.stringify({
    protocol: 'devbridge/result-v1',
    status: 'complete',
    summary: 'contained worker completed',
    observations,
  }) + '\n');
});
`;

function supportedSandboxHost() {
  return process.platform === 'linux' || process.platform === 'win32';
}

function expectedProvider() {
  return process.platform === 'win32' ? 'windows-processcontainer' : 'bubblewrap';
}

test('verified proposal worker cannot reach control state, credentials, Git admin writes, IPC authority, or network', {
  timeout: process.platform === 'win32' ? 90_000 : 45_000,
}, async (t) => {
  if (!supportedSandboxHost()) {
    t.skip('proposal-worker sandbox canary is defined only for Linux and Windows');
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-worker-boundary-'));
  const projectDir = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  const credentialDirectory = path.join(root, 'credential-store');
  const trustedRuntime = path.join(root, 'trusted-runtime');
  const workerScript = path.join(trustedRuntime, 'worker-fixture.mjs');
  try {
    await mkdir(path.join(projectDir, '.git'), { recursive: true, mode: 0o700 });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    await mkdir(trustedRuntime, { recursive: true, mode: 0o700 });

    const stateRead = path.join(stateDirectory, 'authoritative-run-state.json');
    const stateWrite = path.join(stateDirectory, 'worker-escape.txt');
    const daemonRead = path.join(stateDirectory, 'daemon.lock');
    const credentialRead = path.join(credentialDirectory, 'github-cli-token-sentinel.txt');
    const gitConfig = path.join(projectDir, '.git', 'config');
    const controlResult = path.join(stateDirectory, 'worker-exchange', 'run-1', 'turn-1', 'result.json');
    await writeFile(stateRead, 'state-control-sentinel\n', { mode: 0o600 });
    await writeFile(daemonRead, 'daemon-control-sentinel\n', { mode: 0o600 });
    await writeFile(credentialRead, 'github-credential-sentinel\n', { mode: 0o600 });
    await writeFile(gitConfig, 'git-admin-sentinel\n', { mode: 0o600 });
    await writeFile(workerScript, workerFixture, { mode: 0o600 });

    const sourceEnv = {
      ...process.env,
      GH_TOKEN: 'must-not-reach-worker',
      GITHUB_TOKEN: 'must-not-reach-worker-either',
    };
    const provider = createDeterministicSandboxProvider({
      policy: { provider: 'auto', bubblewrapExecutable: 'bwrap' },
      externalReadRoots: [],
      workspaceRoot: root,
      stateDirectory,
      env: sourceEnv,
    });
    const status = await provider.verify();
    if (!status.verified) {
      if (process.env.DEVBRIDGE_REQUIRE_SANDBOX_TEST === '1') {
        assert.fail(`required proposal-worker ${expectedProvider()} boundary verification failed: ${status.reason}`);
      }
      t.skip(`${expectedProvider()} unavailable/unusable on this host: ${status.reason}`);
      return;
    }

    const exchange = new WorkerExchange({ stateDirectory });
    const runner = new ProcessRunner({
      sourceEnv,
      workerExchange: exchange,
      sandboxProvider: provider,
      trustedReadRootsByProfile: {
        'contained-worker-fixture': [trustedRuntime],
      },
    });
    const profile = {
      name: 'contained-worker-fixture',
      executable: process.execPath,
      args: [
        workerScript,
        '{contextFile}',
        stateRead,
        stateWrite,
        daemonRead,
        credentialRead,
        controlResult,
      ],
      inputMode: 'stdin-json',
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      environment: { pass: ['GH_TOKEN', 'GITHUB_TOKEN'], set: {} },
      sandbox: {
        enforcement: 'os',
        outsideProjectRead: 'deny',
        outsideProjectWrite: false,
        network: 'deny',
      },
    };

    const run = await runner.run({
      profile,
      projectDir,
      runDir: path.join(projectDir, '.devbridge', 'run-1', 'turn-1'),
      runId: 'run-1',
      context: { objective: 'attempt boundary attacks and report observations' },
    });

    assert.equal(run.exitCode, 0, run.stderr || run.stdout);
    assert.equal(run.resultParseError, null);
    assert.equal(run.result?.status, 'complete');
    assert.equal(run.result?.summary, 'contained worker completed');
    assert.deepEqual(run.result?.observations, {
      stateReadDenied: true,
      stateWriteDenied: true,
      daemonReadDenied: true,
      credentialReadDenied: true,
      gitWriteDenied: true,
      contextWriteDenied: true,
      controlResultReadDenied: true,
      controlResultWriteDenied: true,
      controlResultUnlinkDenied: true,
      resultParentWriteDenied: true,
      runtimeWriteDenied: true,
      networkDenied: true,
      ghTokenAbsent: true,
      githubTokenAbsent: true,
    });
    if (process.platform === 'linux') {
      assert.equal(run.workerContextFile, WORKER_CONTEXT_FILE);
      assert.equal(run.workerResultFile, WORKER_RESULT_FILE);
      assert.equal(run.sandbox.workerIpc, 'control-owned-exact-file-bindings');
    } else {
      assert.equal(path.resolve(run.workerContextFile), path.resolve(run.contextFile));
      assert.equal(path.basename(run.workerResultFile), 'worker-result-staging.json');
      assert.equal(run.sandbox.workerIpc, 'control-context-plus-worker-staging-import');
      assert.notEqual(path.resolve(run.workerResultFile), path.resolve(run.resultFile));
    }
    assert.equal(run.sandbox.provider, expectedProvider());
    assert.equal(run.sandbox.verified, true);
    assert.equal(run.sandbox.network, 'denied');

    assert.equal(await readFile(stateRead, 'utf8'), 'state-control-sentinel\n');
    assert.equal(await readFile(daemonRead, 'utf8'), 'daemon-control-sentinel\n');
    assert.equal(await readFile(credentialRead, 'utf8'), 'github-credential-sentinel\n');
    assert.equal(await readFile(gitConfig, 'utf8'), 'git-admin-sentinel\n');
    assert.equal(await readFile(workerScript, 'utf8'), workerFixture);
    assert.equal(await readFile(path.join(projectDir, 'worker-project-write.txt'), 'utf8'), 'project-ok\n');
    assert.match(await readFile(run.resultFile, 'utf8'), /contained worker completed/u);
    await assert.rejects(readFile(stateWrite), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(projectDir, '.devbridge')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
