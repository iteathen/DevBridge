import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { splitRepository } from '../security/workspace-policy.js';

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function normalizeRemote(value) {
  return String(value).replace(/\\/g, '/').replace(/\/$/, '');
}

function safeRunId(runId) {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(String(runId))) throw new PolicyError('runId is not safe for a managed path');
  return String(runId);
}

function branchName(task) {
  return `patchpoller/issue-${task.issueNumber}-${task.revision.slice(0, 12)}`;
}

function authBaseUrl(remoteUrl) {
  try {
    return `${new URL(remoteUrl).origin}/`;
  } catch {
    return null;
  }
}

function lines(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export class GitWorkspaceManager {
  #workspace;
  #git;
  #tokenProvider;
  #remoteUrlResolver;
  #fetchTimeoutMs;

  constructor({ workspacePolicy, gitClient, tokenProvider = async () => null, remoteUrlResolver = (repository) => `https://github.com/${repository}.git`, fetchTimeoutMs = 300_000 }) {
    this.#workspace = workspacePolicy;
    this.#git = gitClient;
    this.#tokenProvider = tokenProvider;
    this.#remoteUrlResolver = remoteUrlResolver;
    this.#fetchTimeoutMs = fetchTimeoutMs;
  }

  worktreePath(repository, runId) {
    const [owner, name] = splitRepository(repository);
    return path.join(this.#workspace.root, 'worktrees', owner, name, safeRunId(runId));
  }

  async ensureRepository(repository) {
    const repoDir = this.#workspace.projectPath(repository);
    const remoteUrl = this.#remoteUrlResolver(repository);
    const token = await this.#tokenProvider();
    await this.#workspace.assertWriteContained(repoDir);

    if (!(await exists(path.join(repoDir, '.git')))) {
      const parent = path.dirname(repoDir);
      await this.#workspace.assertWriteContained(parent);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await this.#git.run(['clone', '--no-checkout', '--origin', 'origin', '--', remoteUrl, repoDir], {
        cwd: parent,
        token,
        authBaseUrl: authBaseUrl(remoteUrl),
        timeoutMs: this.#fetchTimeoutMs
      });
    }

    const actualRemote = (await this.#git.run(['remote', 'get-url', 'origin'], { cwd: repoDir })).stdout.trim();
    if (normalizeRemote(actualRemote) !== normalizeRemote(remoteUrl)) {
      throw new PolicyError(`managed repository origin mismatch: expected ${remoteUrl}, found ${actualRemote}`);
    }

    await this.#git.run(['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'], {
      cwd: repoDir,
      token,
      authBaseUrl: authBaseUrl(remoteUrl),
      timeoutMs: this.#fetchTimeoutMs
    });

    let head = await this.#git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoDir, allowFailure: true });
    if (head.exitCode !== 0 || !head.stdout.trim()) {
      await this.#git.run(['remote', 'set-head', 'origin', '--auto'], { cwd: repoDir, allowFailure: true });
      head = await this.#git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoDir, allowFailure: true });
    }
    const baseRef = head.stdout.trim();
    if (!baseRef.startsWith('origin/')) throw new PolicyError('unable to resolve remote default branch');
    const baseSha = (await this.#git.run(['rev-parse', baseRef], { cwd: repoDir })).stdout.trim();

    return { repository, repoDir, remoteUrl, baseRef, baseSha, defaultBranch: baseRef.slice('origin/'.length) };
  }

  async prepareRun(task, runId) {
    const repository = task.envelope.target.repository;
    const repo = await this.ensureRepository(repository);
    const worktreeDir = this.worktreePath(repository, runId);
    const branch = branchName(task);
    await this.#workspace.assertWriteContained(worktreeDir);
    await mkdir(path.dirname(worktreeDir), { recursive: true, mode: 0o700 });

    if (await exists(worktreeDir)) {
      const top = (await this.#git.run(['rev-parse', '--show-toplevel'], { cwd: worktreeDir })).stdout.trim();
      if (path.resolve(top) !== path.resolve(worktreeDir)) throw new PolicyError('existing run worktree identity mismatch');
      const currentBranch = (await this.#git.run(['branch', '--show-current'], { cwd: worktreeDir })).stdout.trim();
      if (currentBranch !== branch) throw new PolicyError(`existing worktree is on unexpected branch ${currentBranch}`);
    } else {
      const branchExists = await this.#git.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo.repoDir, allowFailure: true });
      if (branchExists.exitCode === 0) {
        await this.#git.run(['worktree', 'add', '--', worktreeDir, branch], { cwd: repo.repoDir });
      } else {
        await this.#git.run(['worktree', 'add', '-b', branch, '--', worktreeDir, repo.baseRef], { cwd: repo.repoDir });
      }
    }

    return { ...repo, worktreeDir, branch, runId: safeRunId(runId) };
  }

  async snapshot(workspace) {
    const { worktreeDir, baseSha } = workspace;
    const [head, status, committed, unstaged, untracked, unmerged] = await Promise.all([
      this.#git.run(['rev-parse', 'HEAD'], { cwd: worktreeDir }),
      this.#git.run(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktreeDir }),
      this.#git.run(['diff', '--name-only', `${baseSha}...HEAD`], { cwd: worktreeDir }),
      this.#git.run(['diff', '--name-only'], { cwd: worktreeDir }),
      this.#git.run(['ls-files', '--others', '--exclude-standard'], { cwd: worktreeDir }),
      this.#git.run(['diff', '--name-only', '--diff-filter=U'], { cwd: worktreeDir })
    ]);
    const changedFiles = [...new Set([...lines(committed.stdout), ...lines(unstaged.stdout), ...lines(untracked.stdout)])].sort();
    return {
      branch: workspace.branch,
      baseSha,
      headSha: head.stdout.trim(),
      dirty: status.stdout.trim() !== '',
      changedFiles,
      unmergedFiles: lines(unmerged.stdout),
      status: status.stdout.trim()
    };
  }

  async validate(workspace) {
    const snapshot = await this.snapshot(workspace);
    if (snapshot.unmergedFiles.length > 0) throw new PolicyError(`worktree has unresolved merges: ${snapshot.unmergedFiles.join(', ')}`);
    const committed = await this.#git.run(['diff', '--check', `${workspace.baseSha}...HEAD`], { cwd: workspace.worktreeDir, allowFailure: true });
    const unstaged = await this.#git.run(['diff', '--check'], { cwd: workspace.worktreeDir, allowFailure: true });
    if (committed.exitCode !== 0 || unstaged.exitCode !== 0) {
      throw new PolicyError(`git diff --check failed: ${(committed.stderr || committed.stdout || unstaged.stderr || unstaged.stdout).trim()}`);
    }
    return snapshot;
  }

  async publishTaskBranch(workspace) {
    if (!workspace.branch.startsWith('patchpoller/')) throw new PolicyError('refusing to publish a non-PATCH-POLLER task branch');
    const token = await this.#tokenProvider();
    await this.#git.run(['push', 'origin', `HEAD:refs/heads/${workspace.branch}`], {
      cwd: workspace.worktreeDir,
      token,
      authBaseUrl: authBaseUrl(workspace.remoteUrl),
      timeoutMs: this.#fetchTimeoutMs
    });
    return { branch: workspace.branch, headSha: (await this.#git.run(['rev-parse', 'HEAD'], { cwd: workspace.worktreeDir })).stdout.trim() };
  }
}
