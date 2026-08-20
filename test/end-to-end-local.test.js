import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspacePolicy } from '../src/security/workspace-policy.js';
import { GitClient } from '../src/git/git-client.js';
import { GitWorkspaceManager } from '../src/git/workspace-manager.js';
import { composeWorkRunner } from '../src/app/work-runner-composition.js';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';
import {
  REPOSITORY_EXECUTION_RESULT_PROTOCOL,
  REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  normalizeRepositoryExecutionRequest,
} from '../src/runtime/repository-execution.js';
import { JsonStateStore } from '../src/state/json-state-store.js';
import { RunCoordinator } from '../src/run/run-coordinator.js';

const exec = promisify(execFile);
async function git(cwd, args) { return exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }

function fakeRepositoryExecution(observed) {
  return {
    inspect() {
      return {
        protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
        state: 'ready',
        ready: true,
        identity: 'fake-e2e',
        reason: null,
      };
    },
    async execute(raw) {
      const request = normalizeRepositoryExecutionRequest(raw);
      observed.push(request);
      const resultTransfer = request.transfers.find((entry) => entry.name === 'result');
      await resultTransfer.port.write(`${JSON.stringify({
        protocol: 'devbridge/result-v1',
        status: 'complete',
        summary: 'fake repository execution completed',
        progress: [],
        tests: [{ name: 'fake-execution', status: 'pass' }],
        nextStep: null,
      })}\n`);
      return {
        protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        stdout: '',
        stderr: '',
        startedAt: null,
        finishedAt: null,
        lastOutputAt: null,
        evidence: { identity: 'fake-e2e', scope: request.scope },
      };
    },
  };
}

test('generic coordinator completes through a fake repository executor without provider-specific controller logic', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-e2e-fake-execution-'));
  const source = path.join(root, 'source');
  await exec('git', ['init', '-b', 'main', source]);
  await writeFile(path.join(source, 'README.md'), 'before\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial']);

  const policy = new WorkspacePolicy({ root: path.join(root, 'managed'), allowedOwners: ['owner'], allowCreate: true });
  await policy.ensureRoot();
  const gitClient = new GitClient({ syntheticHome: path.join(root, 'git-home'), allowFileProtocol: true });
  const workspaceManager = new GitWorkspaceManager({ workspacePolicy: policy, gitClient, remoteUrlResolver: () => source });
  const stateDirectory = path.join(root, 'state');
  const stateStore = new JsonStateStore(path.join(stateDirectory, 'queue.json'));
  const observed = [];
  const processRunner = composeWorkRunner({
    mailboxStore: new WorkerExchange({ stateDirectory }),
    activeExecution: fakeRepositoryExecution(observed),
  });

  const profile = {
    name: 'fixture',
    executable: '/host/path/is-not-the-execution-contract',
    args: ['--result', '{resultFile}'],
    inputMode: 'stdin-json',
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    environment: { pass: ['PATH'], set: {} },
    sandbox: { enforcement: 'none', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' },
  };
  const task = {
    queueRepository: 'owner/queue',
    issueNumber: 42,
    actorId: '1',
    revision: 'c'.repeat(64),
    targetRepository: 'owner/repo',
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'Exercise the generic execution path.',
      preferredTool: 'fixture',
      requestedCapabilities: ['project.write', 'process.execute'],
      context: { summary: 'Stage-1 fake-provider acceptance', constraints: [] },
    },
  };

  const coordinator = new RunCoordinator({
    stateStore,
    workspaceManager,
    processRunner,
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 2,
    autoPushTaskBranches: false,
  });

  const result = await coordinator.executeTask(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.published, false);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].scope.repository, 'owner/repo');
  assert.equal(observed[0].invocation.tool, 'fixture');
  assert.doesNotMatch(JSON.stringify(observed[0].invocation), /host\/path/u);

  const worktree = workspaceManager.worktreePath('owner/repo', result.runId);
  assert.equal(await readFile(path.join(worktree, 'README.md'), 'utf8'), 'before\n');
  assert.equal((await git(worktree, ['status', '--porcelain=v1'])).stdout.trim(), '');

  const second = await coordinator.executeTask(task);
  assert.equal(second.skipped, true);
  assert.equal(second.headSha, result.headSha);
});
