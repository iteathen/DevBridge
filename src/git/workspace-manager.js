import { appendFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { CandidateValidationError, PolicyError } from '../errors.js';
import { splitRepository } from '../security/workspace-policy.js';

const RUNTIME_DIR = '.patch-poller';
const RUNTIME_EXCLUDE = `${RUNTIME_DIR}/`;

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
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(String(runId))) {
    throw new PolicyError('runId is not safe for a managed path');
  }
  return String(runId);
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

function isReservedRuntimePath(file) {
  const normalized = String(file).replace(/\\/g, '/');
  return normalized === RUNTIME_DIR || normalized.startsWith(`${RUNTIME_DIR}/`);
}

async function sameFilesystemIdentity(left, right) {
  const [canonicalLeft, canonicalRight] = await Promise.all([realpath(left), realpath(right)]);
  return canonicalLeft === canonicalRight;
}

export class GitWorkspaceManager {
  #workspace;
  #git;
  #tokenProvider;
  #remoteUrlResolver;
  #fetchTimeoutMs;
  #branchPrefix;
  #baselineChannels;
  #defaultBaselineChannel;

  constructor({
    workspacePolicy,
    gitClient,
    tokenProvider = async () => null,
    remoteUrlResolver = (repository) => `https://github.com/${repository}.git`,
    fetchTimeoutMs = 300_000,
    branchPrefix = 'patchpoller',
    baselineChannels = {},
    defaultBaselineChannel = null
  }) {
    this.#workspace = workspacePolicy;
    this.#git = gitClient;
    this.#tokenProvider = tokenProvider;
    this.#remoteUrlResolver = remoteUrlResolver;
    this.#fetchTimeoutMs = fetchTimeoutMs;
    this.#branchPrefix = branchPrefix;
    this.#baselineChannels = { ...baselineChannels };
    this.#defaultBaselineChannel = defaultBaselineChannel;
  }

  branchName(task) {
    return `${this.#branchPrefix}/issue-${task.issueNumber}-${task.revision.slice(0, 12)}`;
  }

  worktreePath(repository, runId) {
    const [owner, name] = splitRepository(repository);
    return path.join(this.#workspace.root, 'worktrees', owner, name, safeRunId(runId));
  }

  async #ensureRuntimeExclude(repoDir) {
    const resolved = (await this.#git.run(['rev-parse', '--git-path', 'info/exclude'], { cwd: repoDir })).stdout.trim();
    const excludeFile = path.resolve(repoDir, resolved);
    await this.#workspace.assertWriteContained(excludeFile);
    await mkdir(path.dirname(excludeFile), { recursive: true, mode: 0o700 });

    let text = '';
    try {
      text = await readFile(excludeFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const entries = new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    if (!entries.has(RUNTIME_EXCLUDE)) {
      const prefix = text !== '' && !text.endsWith('\n') ? '\n' : '';
      await appendFile(excludeFile, `${prefix}${RUNTIME_EXCLUDE}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }

  async ensureRepository(repository) {
    const repoDir = this.#workspace.projectPath(repository);
    const remoteUrl = this.#remoteUrlResolver(repository);
    const token = await this.#tokenProvider();
    await this.#workspace.assertWriteContained(repoDir);

    if (!(await exists(path.join(repoDir, '.git')))) {
      if (!this.#workspace.allowCreate) {
        throw new PolicyError(`managed repository does not exist and workspace.allowCreate is false: ${repository}`);
      }
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

    await this.#ensureRuntimeExclude(repoDir);
    await this.#git.run(['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'], {
      cwd: repoDir,
      token,
      authBaseUrl: authBaseUrl(remoteUrl),
      timeoutMs: this.#fetchTimeoutMs
    });

    let head = await this.#git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: repoDir,
      allowFailure: true
    });
    if (head.exitCode !== 0 || !head.stdout.trim()) {
      await this.#git.run(['remote', 'set-head', 'origin', '--auto'], { cwd: repoDir, allowFailure: true });
      head = await this.#git.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
        cwd: repoDir,
        allowFailure: true
      });
    }
    const baseRef = head.stdout.trim();
    if (!baseRef.startsWith('origin/')) throw new PolicyError('unable to resolve remote default branch');
    const baseSha = (await this.#git.run(['rev-parse', baseRef], { cwd: repoDir })).stdout.trim();

    return {
      repository,
      repoDir,
      remoteUrl,
      baseRef,
      baseSha,
      baselineChannel: null,
      defaultBranch: baseRef.slice('origin/'.length)
    };
  }

  async #resolveBaseline(repo, requestedChannel) {
    const channel = requestedChannel ?? this.#defaultBaselineChannel;
    if (!channel) return { baseRef: repo.baseRef, baseSha: repo.baseSha, baselineChannel: null };
    const branch = this.#baselineChannels[channel];
    if (!branch) throw new PolicyError(`baseline channel ${channel} is not authorized by local policy`);
    const baseRef = `origin/${branch}`;
    const resolved = await this.#git.run(['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: repo.repoDir,
      allowFailure: true
    });
    if (resolved.exitCode !== 0 || !/^[0-9a-f]{40}$/iu.test(resolved.stdout.trim())) {
      throw new PolicyError(`authorized baseline channel ${channel} is unavailable for ${repo.repository}`);
    }
    return { baseRef, baseSha: resolved.stdout.trim().toLowerCase(), baselineChannel: channel };
  }

  async prepareRun(task, runId, resume = {}) {
    const repository = task.envelope.target.repository;
    const repo = await this.ensureRepository(repository);
    const worktreeDir = this.worktreePath(repository, runId);
    const branch = this.branchName(task);
    let baseRef;
    let baseSha;
    let baselineChannel;

    if (resume.baseSha) {
      baseRef = resume.baseRef ?? repo.baseRef;
      baseSha = resume.baseSha;
      baselineChannel = resume.baselineChannel ?? null;
      const existsBase = await this.#git.run(['cat-file', '-e', `${baseSha}^{commit}`], {
        cwd: repo.repoDir,
        allowFailure: true
      });
      if (existsBase.exitCode !== 0) throw new PolicyError(`persisted run baseline is no longer available locally: ${baseSha}`);
    } else {
      const baseline = await this.#resolveBaseline(repo, resume.baselineChannel ?? task.envelope.controllerPlan?.baselineChannel ?? null);
      ({ baseRef, baseSha, baselineChannel } = baseline);
    }

    await this.#workspace.assertWriteContained(worktreeDir);
    await mkdir(path.dirname(worktreeDir), { recursive: true, mode: 0o700 });

    if (await exists(worktreeDir)) {
      const top = (await this.#git.run(['rev-parse', '--show-toplevel'], { cwd: worktreeDir })).stdout.trim();
      if (!(await sameFilesystemIdentity(top, worktreeDir))) throw new PolicyError('existing run worktree identity mismatch');
      const currentBranch = (await this.#git.run(['branch', '--show-current'], { cwd: worktreeDir })).stdout.trim();
      if (currentBranch !== branch) throw new PolicyError(`existing worktree is on unexpected branch ${currentBranch}`);
    } else {
      const branchExists = await this.#git.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: repo.repoDir,
        allowFailure: true
      });
      if (branchExists.exitCode === 0) {
        await this.#git.run(['worktree', 'add', '--', worktreeDir, branch], { cwd: repo.repoDir });
      } else {
        await this.#git.run(['worktree', 'add', '-b', branch, '--', worktreeDir, baseSha], { cwd: repo.repoDir });
      }
    }

    return { ...repo, baseRef, baseSha, baselineChannel, worktreeDir, branch, runId: safeRunId(runId) };
  }

  async snapshot(workspace) {
    const { worktreeDir, baseSha } = workspace;
    const head = await this.#git.run(['rev-parse', 'HEAD'], { cwd: worktreeDir });
    const status = await this.#git.run(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktreeDir });
    const committed = await this.#git.run(['diff', '--name-only', `${baseSha}...HEAD`], { cwd: worktreeDir });
    const staged = await this.#git.run(['diff', '--cached', '--name-only'], { cwd: worktreeDir });
    const unstaged = await this.#git.run(['diff', '--name-only'], { cwd: worktreeDir });
    const untracked = await this.#git.run(['ls-files', '--others', '--exclude-standard'], { cwd: worktreeDir });
    const unmerged = await this.#git.run(['diff', '--name-only', '--diff-filter=U'], { cwd: worktreeDir });

    const changedFiles = [...new Set([
      ...lines(committed.stdout),
      ...lines(staged.stdout),
      ...lines(unstaged.stdout),
      ...lines(untracked.stdout)
    ])].sort();

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
    if (snapshot.unmergedFiles.length > 0) {
      throw new PolicyError(`worktree has unresolved merges: ${snapshot.unmergedFiles.join(', ')}`);
    }
    const reserved = snapshot.changedFiles.filter(isReservedRuntimePath);
    if (reserved.length > 0) {
      throw new PolicyError(`reserved PATCH-POLLER runtime paths may not become project changes: ${reserved.join(', ')}`);
    }

    const committed = await this.#git.run(['diff', '--check', `${workspace.baseSha}...HEAD`], {
      cwd: workspace.worktreeDir,
      allowFailure: true
    });
    const staged = await this.#git.run(['diff', '--cached', '--check'], {
      cwd: workspace.worktreeDir,
      allowFailure: true
    });
    const unstaged = await this.#git.run(['diff', '--check'], {
      cwd: workspace.worktreeDir,
      allowFailure: true
    });
    if (committed.exitCode !== 0 || staged.exitCode !== 0 || unstaged.exitCode !== 0) {
      throw new PolicyError(`git diff --check failed: ${(committed.stderr || committed.stdout || staged.stderr || staged.stdout || unstaged.stderr || unstaged.stdout).trim()}`);
    }
    return snapshot;
  }

  async #restoreProposalIndex(workspace) {
    const reset = await this.#git.run(['reset', '--quiet', 'HEAD', '--', '.'], {
      cwd: workspace.worktreeDir,
      allowFailure: true
    });
    if (reset.exitCode !== 0) {
      throw new PolicyError(`failed to restore PATCH-POLLER-owned candidate index after rejected seal: ${(reset.stderr || reset.stdout).trim()}`);
    }
  }

  async #validateProposal(workspace) {
    try {
      return await this.validate(workspace);
    } catch (error) {
      if (error instanceof PolicyError) {
        throw new CandidateValidationError(error.message, { cause: error });
      }
      throw error;
    }
  }

  async sealCandidate(workspace, { issueNumber, revision }) {
    let snapshot = await this.snapshot(workspace);
    if (!snapshot.dirty) return snapshot;

    await this.#restoreProposalIndex(workspace);
    snapshot = await this.#validateProposal(workspace);
    if (!snapshot.dirty) return snapshot;

    let committed = false;
    try {
      await this.#git.run(['add', '-A', '--', '.'], { cwd: workspace.worktreeDir });
      const staged = await this.#git.run(['diff', '--cached', '--name-only'], { cwd: workspace.worktreeDir });
      const stagedFiles = lines(staged.stdout);
      const reserved = stagedFiles.filter(isReservedRuntimePath);
      if (reserved.length > 0) {
        throw new CandidateValidationError(`refusing to seal reserved PATCH-POLLER runtime paths: ${reserved.join(', ')}`);
      }
      if (stagedFiles.length === 0) {
        await this.#restoreProposalIndex(workspace);
        return this.#validateProposal(workspace);
      }

      const check = await this.#git.run(['diff', '--cached', '--check'], {
        cwd: workspace.worktreeDir,
        allowFailure: true
      });
      if (check.exitCode !== 0) {
        throw new CandidateValidationError(`staged candidate failed git diff --check: ${(check.stderr || check.stdout).trim()}`);
      }

      const message = `PATCH-POLLER issue #${issueNumber} ${String(revision).slice(0, 12)}`;
      await this.#git.run([
        '-c', 'user.name=PATCH-POLLER',
        '-c', 'user.email=patch-poller@localhost',
        '-c', 'commit.gpgSign=false',
        'commit', '--no-gpg-sign', '-m', message
      ], { cwd: workspace.worktreeDir });
      committed = true;
    } catch (error) {
      if (!committed) await this.#restoreProposalIndex(workspace);
      throw error;
    }

    snapshot = await this.validate(workspace);
    if (snapshot.dirty) throw new PolicyError('candidate remained dirty after PATCH-POLLER sealed it');
    return snapshot;
  }

  async publishTaskBranch(workspace) {
    if (!workspace.branch.startsWith(`${this.#branchPrefix}/`)) {
      throw new PolicyError('refusing to publish a non-PATCH-POLLER task branch');
    }
    const snapshot = await this.validate(workspace);
    if (snapshot.dirty) throw new PolicyError('refusing to publish an unsealed dirty task branch');

    const token = await this.#tokenProvider();
    await this.#git.run(['push', 'origin', `HEAD:refs/heads/${workspace.branch}`], {
      cwd: workspace.worktreeDir,
      token,
      authBaseUrl: authBaseUrl(workspace.remoteUrl),
      timeoutMs: this.#fetchTimeoutMs
    });
    return {
      branch: workspace.branch,
      headSha: (await this.#git.run(['rev-parse', 'HEAD'], { cwd: workspace.worktreeDir })).stdout.trim()
    };
  }
}
