import { appendFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  BaselineReconciliationError,
  BaselineReverificationRequiredError,
  CandidateValidationError,
  PolicyError,
} from '../errors.js';
import { splitRepository } from '../security/workspace-policy.js';

const RUNTIME_DIR = '.patch-poller';
const RUNTIME_EXCLUDE = `${RUNTIME_DIR}/`;
const SHA_RE = /^[0-9a-f]{40}$/u;
const MAX_KNOWN_TASK_BRANCH_HEADS = 16;

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

function normalizeSha(value, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!SHA_RE.test(normalized)) throw new PolicyError(`${label} must be an exact 40-hex Git commit SHA`);
  return normalized;
}

function normalizeKnownTaskBranchHeads(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_KNOWN_TASK_BRANCH_HEADS) {
    throw new PolicyError(`persisted known task-branch heads must contain at most ${MAX_KNOWN_TASK_BRANCH_HEADS} commit SHAs`);
  }
  return [...new Set(value.map((entry) => normalizeSha(entry, 'known task-branch head')))];
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
    const baseSha = normalizeSha((await this.#git.run(['rev-parse', baseRef], { cwd: repoDir })).stdout.trim(), 'repository baseline');

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
    if (resolved.exitCode !== 0 || !SHA_RE.test(resolved.stdout.trim().toLowerCase())) {
      throw new PolicyError(`authorized baseline channel ${channel} is unavailable for ${repo.repository}`);
    }
    return { baseRef, baseSha: resolved.stdout.trim().toLowerCase(), baselineChannel: channel };
  }

  async #resolveCurrentPublicationBaseline(repo, workspace) {
    const baseRef = workspace.baseRef;
    if (workspace.baselineChannel) {
      const branch = this.#baselineChannels[workspace.baselineChannel];
      if (!branch) throw new PolicyError(`persisted baseline channel ${workspace.baselineChannel} is no longer authorized by local policy`);
      const expectedRef = `origin/${branch}`;
      if (baseRef !== expectedRef) throw new PolicyError('persisted baseline ref does not match the locally authorized baseline channel');
    }
    if (typeof baseRef !== 'string' || !baseRef.startsWith('origin/')) {
      throw new PolicyError('persisted baseline ref must remain an origin remote-tracking branch');
    }
    const resolved = await this.#git.run(['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: repo.repoDir,
      allowFailure: true
    });
    if (resolved.exitCode !== 0 || !SHA_RE.test(resolved.stdout.trim().toLowerCase())) {
      throw new PolicyError(`persisted publication baseline ref ${baseRef} is unavailable for ${repo.repository}`);
    }
    return { baseRef, baseSha: resolved.stdout.trim().toLowerCase() };
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
      baseSha = normalizeSha(resume.baseSha, 'persisted run baseline');
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

    const publicationBaseSha = normalizeSha(resume.publicationBaseSha ?? baseSha, 'publication baseline');
    const existsPublicationBase = await this.#git.run(['cat-file', '-e', `${publicationBaseSha}^{commit}`], {
      cwd: repo.repoDir,
      allowFailure: true
    });
    if (existsPublicationBase.exitCode !== 0) {
      throw new PolicyError(`persisted publication baseline is no longer available locally: ${publicationBaseSha}`);
    }
    const taskBranchKnownRemoteHeads = normalizeKnownTaskBranchHeads(resume.taskBranchKnownRemoteHeads);

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
        await this.#git.run(['worktree', 'add', '-b', branch, '--', worktreeDir, publicationBaseSha], { cwd: repo.repoDir });
      }
    }

    return {
      ...repo,
      baseRef,
      baseSha,
      baselineChannel,
      publicationBaseSha,
      taskBranchKnownRemoteHeads,
      worktreeDir,
      branch,
      runId: safeRunId(runId)
    };
  }

  async snapshot(workspace) {
    const { worktreeDir, baseSha } = workspace;
    const publicationBaseSha = normalizeSha(workspace.publicationBaseSha ?? baseSha, 'publication baseline');
    const head = await this.#git.run(['rev-parse', 'HEAD'], { cwd: worktreeDir });
    const status = await this.#git.run(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktreeDir });
    const committed = await this.#git.run(['diff', '--name-only', `${publicationBaseSha}...HEAD`], { cwd: worktreeDir });
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
      publicationBaseSha,
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

    const committed = await this.#git.run(['diff', '--check', `${snapshot.publicationBaseSha}...HEAD`], {
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

  async reconcilePublicationBaseline(workspace) {
    const before = await this.validate(workspace);
    if (before.dirty) throw new CandidateValidationError('publication baseline reconciliation requires a sealed clean candidate');

    const repo = await this.ensureRepository(workspace.repository);
    const current = await this.#resolveCurrentPublicationBaseline(repo, workspace);
    const fromBaseSha = normalizeSha(workspace.publicationBaseSha ?? workspace.baseSha, 'publication baseline');
    if (current.baseSha === fromBaseSha) {
      return { changed: false, fromBaseSha, toBaseSha: fromBaseSha, fromHeadSha: before.headSha, toHeadSha: before.headSha, snapshot: before };
    }

    const upstreamFastForward = await this.#git.run(['merge-base', '--is-ancestor', fromBaseSha, current.baseSha], {
      cwd: workspace.repoDir,
      allowFailure: true
    });
    if (upstreamFastForward.exitCode === 1) {
      throw new BaselineReconciliationError(
        `publication baseline ${workspace.baseRef} no longer descends from the previously verified publication baseline`,
        {
          kind: 'upstream-history-rewrite',
          reconciliation: { fromBaseSha, toBaseSha: current.baseSha, fromHeadSha: before.headSha }
        }
      );
    }
    if (upstreamFastForward.exitCode !== 0) {
      throw new PolicyError(`unable to compare publication baseline ancestry: ${(upstreamFastForward.stderr || upstreamFastForward.stdout).trim()}`);
    }

    const candidateDescendsFromBase = await this.#git.run(['merge-base', '--is-ancestor', fromBaseSha, before.headSha], {
      cwd: workspace.repoDir,
      allowFailure: true
    });
    if (candidateDescendsFromBase.exitCode === 1) {
      throw new PolicyError('candidate branch no longer descends from its persisted publication baseline');
    }
    if (candidateDescendsFromBase.exitCode !== 0) {
      throw new PolicyError(`unable to compare candidate ancestry: ${(candidateDescendsFromBase.stderr || candidateDescendsFromBase.stdout).trim()}`);
    }

    const fromHeadSha = normalizeSha(before.headSha, 'candidate head');
    if (fromHeadSha === fromBaseSha) {
      await this.#git.run(['reset', '--hard', current.baseSha], { cwd: workspace.worktreeDir });
    } else {
      const rebased = await this.#git.run([
        '-c', 'user.name=PATCH-POLLER',
        '-c', 'user.email=patch-poller@localhost',
        '-c', 'commit.gpgSign=false',
        'rebase', '--no-autostash', '--onto', current.baseSha, fromBaseSha, workspace.branch
      ], { cwd: workspace.worktreeDir, allowFailure: true });
      if (rebased.exitCode !== 0) {
        const conflicted = await this.#git.run(['diff', '--name-only', '--diff-filter=U'], {
          cwd: workspace.worktreeDir,
          allowFailure: true
        });
        const files = lines(conflicted.stdout);
        const aborted = await this.#git.run(['rebase', '--abort'], { cwd: workspace.worktreeDir, allowFailure: true });
        if (aborted.exitCode !== 0) {
          throw new PolicyError(`automatic baseline rebase failed and PATCH-POLLER could not restore the pre-rebase candidate: ${(aborted.stderr || aborted.stdout).trim()}`);
        }
        const restoredHead = normalizeSha((await this.#git.run(['rev-parse', 'HEAD'], { cwd: workspace.worktreeDir })).stdout.trim(), 'restored candidate head');
        if (restoredHead !== fromHeadSha) throw new PolicyError('automatic baseline rebase abort did not restore the exact candidate head');
        throw new BaselineReconciliationError(
          `automatic baseline rebase conflicted with ${current.baseRef}; the pre-rebase candidate was restored${files.length ? ` (${files.join(', ')})` : ''}`,
          {
            kind: 'conflict',
            files,
            reconciliation: { fromBaseSha, toBaseSha: current.baseSha, fromHeadSha }
          }
        );
      }
    }

    const toHeadSha = normalizeSha((await this.#git.run(['rev-parse', 'HEAD'], { cwd: workspace.worktreeDir })).stdout.trim(), 'rebased candidate head');
    workspace.publicationBaseSha = current.baseSha;
    const snapshot = await this.validate(workspace);
    if (snapshot.dirty) throw new PolicyError('candidate became dirty while reconciling the publication baseline');
    return {
      changed: true,
      fromBaseSha,
      toBaseSha: current.baseSha,
      fromHeadSha,
      toHeadSha,
      snapshot
    };
  }

  async sealCandidate(workspace, { issueNumber, revision }) {
    let snapshot = await this.snapshot(workspace);

    if (snapshot.dirty) {
      await this.#restoreProposalIndex(workspace);
      snapshot = await this.#validateProposal(workspace);

      if (snapshot.dirty) {
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
          } else {
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
          }
        } catch (error) {
          if (!committed) await this.#restoreProposalIndex(workspace);
          throw error;
        }
      }
    }

    snapshot = await this.validate(workspace);
    if (snapshot.dirty) throw new PolicyError('candidate remained dirty after PATCH-POLLER sealed it');
    const reconciliation = await this.reconcilePublicationBaseline(workspace);
    if (reconciliation.changed) {
      throw new BaselineReverificationRequiredError(
        `upstream baseline advanced from ${reconciliation.fromBaseSha} to ${reconciliation.toBaseSha}; PATCH-POLLER rebased the sealed candidate and requires fresh verification before publication`,
        reconciliation
      );
    }
    return reconciliation.snapshot;
  }

  async #remoteTaskBranchHead(workspace, token, ref) {
    const observed = await this.#git.run(['ls-remote', '--heads', 'origin', ref], {
      cwd: workspace.worktreeDir,
      token,
      authBaseUrl: authBaseUrl(workspace.remoteUrl),
      timeoutMs: this.#fetchTimeoutMs
    });
    const entries = lines(observed.stdout);
    if (entries.length === 0) return null;
    if (entries.length !== 1) throw new PolicyError(`remote task branch observation returned multiple refs for ${ref}`);
    const [sha, observedRef] = entries[0].split(/\s+/u);
    if (observedRef !== ref) throw new PolicyError(`remote task branch observation returned unexpected ref ${observedRef}`);
    return normalizeSha(sha, 'remote task branch head');
  }

  #rememberKnownTaskBranchHead(workspace, headSha) {
    workspace.taskBranchKnownRemoteHeads = normalizeKnownTaskBranchHeads([
      ...(workspace.taskBranchKnownRemoteHeads ?? []),
      headSha
    ].slice(-MAX_KNOWN_TASK_BRANCH_HEADS));
  }

  async publishTaskBranch(workspace) {
    if (!workspace.branch.startsWith(`${this.#branchPrefix}/`)) {
      throw new PolicyError('refusing to publish a non-PATCH-POLLER task branch');
    }
    const snapshot = await this.validate(workspace);
    if (snapshot.dirty) throw new PolicyError('refusing to publish an unsealed dirty task branch');

    const token = await this.#tokenProvider();
    const ref = `refs/heads/${workspace.branch}`;
    const localHead = normalizeSha(snapshot.headSha, 'local task branch head');
    const remoteHead = await this.#remoteTaskBranchHead(workspace, token, ref);
    if (remoteHead === localHead) {
      this.#rememberKnownTaskBranchHead(workspace, localHead);
      return { branch: workspace.branch, headSha: localHead, reconciled: true, previousRemoteHeadSha: remoteHead };
    }

    const knownRemoteHeads = new Set(normalizeKnownTaskBranchHeads(workspace.taskBranchKnownRemoteHeads));
    let expectation;
    if (remoteHead == null) expectation = '';
    else if (knownRemoteHeads.has(remoteHead)) expectation = remoteHead;
    else throw new PolicyError(`remote PATCH-POLLER task branch moved to unexpected head ${remoteHead}; refusing to overwrite it`);

    const pushed = await this.#git.run([
      'push', `--force-with-lease=${ref}:${expectation}`, 'origin', `HEAD:${ref}`
    ], {
      cwd: workspace.worktreeDir,
      token,
      authBaseUrl: authBaseUrl(workspace.remoteUrl),
      timeoutMs: this.#fetchTimeoutMs,
      allowFailure: true
    });

    const reconciledHead = await this.#remoteTaskBranchHead(workspace, token, ref);
    if (reconciledHead !== localHead) {
      throw new PolicyError(`task branch publication did not converge on the exact local head: ${(pushed.stderr || pushed.stdout).trim()}`);
    }
    this.#rememberKnownTaskBranchHead(workspace, localHead);
    return {
      branch: workspace.branch,
      headSha: localHead,
      reconciled: pushed.exitCode !== 0 || pushed.timedOut === true,
      previousRemoteHeadSha: remoteHead
    };
  }
}
