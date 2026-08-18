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
import { ProcessRunner } from '../src/runtime/process-runner.js';
import { JsonStateStore } from '../src/state/json-state-store.js';
import { RunCoordinator } from '../src/run/run-coordinator.js';

const exec = promisify(execFile);
async function git(cwd, args) { return exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }

test('first-version local pipeline turns a task into a sealed candidate commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-e2e-'));
  const source = path.join(root, 'source');
  await exec('git', ['init', '-b', 'main', source]);
  await writeFile(path.join(source, 'README.md'), 'before\n');
  await git(source, ['add', 'README.md']);
  await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial']);

  const policy = new WorkspacePolicy({ root: path.join(root, 'managed'), allowedOwners: ['owner'], allowCreate: true });
  await policy.ensureRoot();
  const gitClient = new GitClient({ syntheticHome: path.join(root, 'git-home'), allowFileProtocol: true });
  const workspaceManager = new GitWorkspaceManager({ workspacePolicy: policy, gitClient, remoteUrlResolver: () => source });
  const stateStore = new JsonStateStore(path.join(root, 'state', 'queue.json'));
  const processRunner = new ProcessRunner();

  const fixtureCode = `
    const fs = require('node:fs');
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const context = JSON.parse(input);
      fs.writeFileSync('README.md', 'after\\n');
      fs.writeFileSync(context.bridge.resultFile, JSON.stringify({
        protocol: 'patch-poller/result-v1',
        status: 'complete',
        summary: 'fixture finished',
        progress: ['edited README'],
        tests: [{ name: 'fixture', status: 'pass' }],
        nextStep: null
      }));
    });
  `;
  const profile = {
    executable: process.execPath,
    args: ['-e', fixtureCode],
    inputMode: 'stdin-json',
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    environment: { pass: ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'], set: {} },
    sandbox: { enforcement: 'os', outsideProjectRead: 'deny', outsideProjectWrite: false, network: 'deny' }
  };
  const task = {
    queueRepository: 'owner/queue',
    issueNumber: 42,
    actorId: '1',
    revision: 'c'.repeat(64),
    envelope: {
      target: { repository: 'owner/repo' },
      instructions: 'Change README.',
      preferredTool: 'fixture',
      requestedCapabilities: ['project.write', 'process.execute'],
      context: { summary: 'local acceptance test', constraints: [] }
    }
  };

  const coordinator = new RunCoordinator({
    stateStore,
    workspaceManager,
    processRunner,
    queueRepository: 'owner/queue',
    tools: { fixture: profile },
    defaultTool: 'fixture',
    maxTurns: 2,
    autoPushTaskBranches: false
  });

  const result = await coordinator.executeTask(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.published, false);
  assert.deepEqual(result.changedFiles, ['README.md']);

  const worktree = workspaceManager.worktreePath('owner/repo', result.runId);
  assert.equal(await readFile(path.join(worktree, 'README.md'), 'utf8'), 'after\n');
  assert.equal((await git(worktree, ['status', '--porcelain=v1'])).stdout.trim(), '');
  assert.match((await git(worktree, ['log', '-1', '--pretty=%s'])).stdout.trim(), /^PATCH-POLLER issue #42 /);

  const second = await coordinator.executeTask(task);
  assert.equal(second.skipped, true);
  assert.equal(second.headSha, result.headSha);
});
