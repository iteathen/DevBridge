import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { WorkspacePolicy } from '../src/security/workspace-policy.js';
import { GitClient } from '../src/git/git-client.js';
import { GitWorkspaceManager } from '../src/git/workspace-manager.js';
import { JsonStateStore } from '../src/state/json-state-store.js';
import { RunCoordinator } from '../src/run/run-coordinator.js';
import { ManagedScratchTransaction } from '../src/runtime/managed-scratch.js';
import { createCoreOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { DeterministicProcessRunner } from '../src/runtime/deterministic-process-runner.js';
import { createDeterministicSandboxProvider } from '../src/runtime/deterministic-sandbox.js';
import { ProcessRunner } from '../src/runtime/process-runner.js';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';

const exec = promisify(execFile);
async function git(cwd, args) {
  return exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function requireWindowsAcceptance(t) {
  if (process.platform !== 'win32') {
    t.skip('real Windows workload acceptance is Windows-only');
    return false;
  }
  if (process.env.DEVBRIDGE_REQUIRE_WINDOWS_WORKLOAD_TEST !== '1') {
    t.skip('real Windows workload acceptance is enabled only on the prepared ProcessContainer CI host');
    return false;
  }
  return true;
}

async function runCmakeAcceptance({ workspaceRoot, provider }) {
  const projectDir = path.join(workspaceRoot, 'cmake-project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'CMakeLists.txt'), [
    'cmake_minimum_required(VERSION 3.20)',
    'project(devbridge_windows_acceptance NONE)',
    'add_custom_command(',
    '  OUTPUT "${CMAKE_BINARY_DIR}/built.txt"',
    '  COMMAND "${CMAKE_COMMAND}" -E touch "${CMAKE_BINARY_DIR}/built.txt"',
    '  VERBATIM',
    ')',
    'add_custom_target(marker ALL DEPENDS "${CMAKE_BINARY_DIR}/built.txt")',
    'enable_testing()',
    'add_test(NAME marker_exists COMMAND "${CMAKE_COMMAND}" -E compare_files "${CMAKE_BINARY_DIR}/built.txt" "${CMAKE_BINARY_DIR}/built.txt")',
    '',
  ].join('\n'));

  const state = { controllerPlan: { scratchLedger: [] } };
  const scratch = new ManagedScratchTransaction({
    workspace: { worktreeDir: projectDir, runId: 'windows-cmake-acceptance' },
    state,
    persist: async () => {},
  });
  const processRunner = new DeterministicProcessRunner({ sandboxProvider: provider });
  const registry = createCoreOperationRegistry();
  const context = { projectDir, processRunner, scratch };

  try {
    const configure = await registry.execute('cmake.configure', {
      sourcePath: 'CMakeLists.txt',
      buildId: 'acceptance',
    }, context);
    assert.equal(configure.exitCode, 0, configure.stderr || configure.stdout);
    assert.equal(configure.sandbox?.provider, 'windows-processcontainer');
    assert.equal(configure.sandbox?.verified, true);

    const build = await registry.execute('cmake.build', {
      buildId: 'acceptance',
      target: 'marker',
    }, context);
    assert.equal(build.exitCode, 0, build.stderr || build.stdout);
    assert.equal(build.sandbox?.verified, true);

    const ctest = await registry.execute('ctest.run', { buildId: 'acceptance' }, context);
    assert.equal(ctest.exitCode, 0, ctest.stderr || ctest.stdout);
    assert.equal(ctest.sandbox?.verified, true);
    assert.match(ctest.stdout, /100% tests passed/u);
  } finally {
    const cleanup = await scratch.cleanup();
    assert.deepEqual(cleanup.leftovers, []);
  }
}

async function runEndToEndAcceptance({ root, workspaceRoot, stateDirectory, provider }) {
  const source = path.join(root, 'source');
  await exec('git', ['init', '-b', 'main', source]);
  await writeFile(path.join(source, 'README.md'), 'before\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial']);

  const policy = new WorkspacePolicy({ root: workspaceRoot, allowedOwners: ['owner'], allowCreate: true });
  await policy.ensureRoot();
  const gitClient = new GitClient({ syntheticHome: path.join(root, 'git-home'), allowFileProtocol: true });
  const workspaceManager = new GitWorkspaceManager({
    workspacePolicy: policy,
    gitClient,
    remoteUrlResolver: () => source,
  });
  const stateStore = new JsonStateStore(path.join(stateDirectory, 'queue.json'));
  const processRunner = new ProcessRunner({
    workerExchange: new WorkerExchange({ stateDirectory }),
    sandboxProvider: provider,
  });

  const fixtureCode = `
    const fs = require('node:fs');
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      JSON.parse(input);
      fs.writeFileSync('README.md', 'after\\n');
      fs.writeFileSync(process.argv[1], JSON.stringify({
        protocol: 'devbridge/result-v1',
        status: 'complete',
        summary: 'verified Windows worker completed',
        progress: ['edited README'],
        tests: [{ name: 'windows-processcontainer-e2e', status: 'pass' }],
        nextStep: null
      }));
    });
  `;
  const profile = {
    name: 'windows-e2e-fixture',
    executable: process.execPath,
    args: ['-e', fixtureCode, '{resultFile}'],
    inputMode: 'stdin-json',
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    environment: {
      pass: ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP'],
      set: {},
    },
    sandbox: {
      enforcement: 'os',
      outsideProjectRead: 'deny',
      outsideProjectWrite: false,
      network: 'deny',
    },
  };
  const task = {
    queueRepository: 'owner/queue',
    issueNumber: 4242,
    actorId: '1',
    revision: 'd'.repeat(64),
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'Change README.',
      preferredTool: 'windows-e2e-fixture',
      requestedCapabilities: ['project.write', 'process.execute'],
      context: { summary: 'verified Windows end-to-end acceptance', constraints: [] },
    },
  };

  const coordinator = new RunCoordinator({
    stateStore,
    workspaceManager,
    processRunner,
    queueRepository: 'owner/queue',
    tools: { 'windows-e2e-fixture': profile },
    defaultTool: 'windows-e2e-fixture',
    maxTurns: 2,
    autoPushTaskBranches: false,
  });

  const result = await coordinator.executeTask(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.published, false);
  assert.deepEqual(result.changedFiles, ['README.md']);

  const worktree = workspaceManager.worktreePath('owner/repo', result.runId);
  assert.equal(await readFile(path.join(worktree, 'README.md'), 'utf8'), 'after\n');
  assert.equal((await git(worktree, ['status', '--porcelain=v1'])).stdout.trim(), '');
  assert.match((await git(worktree, ['log', '-1', '--pretty=%s'])).stdout.trim(), /^DevBridge issue #4242 /u);

  const second = await coordinator.executeTask(task);
  assert.equal(second.skipped, true);
  assert.equal(second.headSha, result.headSha);
}

test('verified Windows ProcessContainer runs CMake/CTest and a sealed DevBridge task end to end', {
  timeout: 5 * 60_000,
}, async (t) => {
  if (!requireWindowsAcceptance(t)) return;

  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-windows-workload-'));
  const workspaceRoot = path.join(root, 'managed');
  const stateDirectory = path.join(root, 'state');
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDirectory, { recursive: true });
    const provider = createDeterministicSandboxProvider({
      policy: { provider: 'windows-processcontainer', bubblewrapExecutable: 'bwrap' },
      externalReadRoots: [],
      workspaceRoot,
      stateDirectory,
      env: process.env,
    });
    const status = await provider.verify();
    assert.equal(status.available, true, status.reason);
    assert.equal(status.verified, true, status.reason);
    assert.equal(status.provider, 'windows-processcontainer');

    await runCmakeAcceptance({ workspaceRoot, provider });
    await runEndToEndAcceptance({ root, workspaceRoot, stateDirectory, provider });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
