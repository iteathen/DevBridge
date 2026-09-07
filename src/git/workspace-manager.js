import path from 'node:path';
import {
  BaselineReconciliationError,
  BaselineReverificationRequiredError,
  CandidateValidationError,
  PolicyError,
  RepositoryAdmissionError,
} from '../errors.js';
import { splitRepository } from '../security/workspace-policy.js';
import { BaselineAuthority } from './workspace-manager/baseline-authority.js';
import { BaselineReconciliation } from './workspace-manager/baseline-reconciliation.js';
import { CandidateSealing } from './workspace-manager/candidate-sealing.js';
import { PublicationTransaction } from './workspace-manager/publication-transaction.js';
import { RepositoryAdmission } from './workspace-manager/repository-admission.js';
import { WorkspaceObservation } from './workspace-manager/workspace-observation.js';
import { WorktreeLifecycle } from './workspace-manager/worktree-lifecycle.js';

const RUNTIME_DIR = '.devbridge';
const RUNTIME_EXCLUDE = `${RUNTIME_DIR}/`;
const SHA_RE = /^[0-9a-f]{40}$/u;

function repositoryAdmissionError(phase, kind, repair, details = {}) {
  return new RepositoryAdmissionError(`repository admission failed during ${phase}: ${kind}; ${repair}`, {
    phase,
    kind,
    repair,
    ...details,
  });
}

function safeRunId(runId) {
  if (!/^[A-Za-z0-9_.-]{1,120}$/u.test(String(runId))) throw new PolicyError('runId is not safe for a managed path');
  return String(runId);
}

function isReservedRuntimePath(file) {
  const normalized = String(file).replace(/\\/gu, '/');
  return normalized === RUNTIME_DIR || normalized.startsWith(`${RUNTIME_DIR}/`);
}

function normalizeSha(value, label) {
  const normalized = String(value ?? '').toLowerCase();
  if (!SHA_RE.test(normalized)) throw new PolicyError(`${label} must be an exact 40-hex Git commit SHA`);
  return normalized;
}

export class GitWorkspaceManager {
  #workspace;
  #run;
  #tokenProvider;
  #branchPrefix;
  #admission;
  #baseline;
  #lifecycle;
  #observation;
  #sealing;
  #reconciliation;
  #publication;

  constructor({
    workspacePolicy,
    gitClient,
    tokenProvider = async () => null,
    remoteUrlResolver = (repository) => `https://github.com/${repository}.git`,
    fetchTimeoutMs = 300_000,
    branchPrefix = 'devbridge',
    baselineChannels = {},
    defaultBaselineChannel = null,
  }) {
    this.#workspace = workspacePolicy;
    this.#run = (argumentsList, options) => gitClient.run(argumentsList, options);
    this.#tokenProvider = tokenProvider;
    this.#branchPrefix = branchPrefix;

    this.#admission = new RepositoryAdmission({
      run: this.#run,
      allowCreate: () => this.#workspace.allowCreate,
      assertContained: (value) => this.#workspace.assertWriteContained(value),
      location: (subject) => this.#workspace.projectPath(subject),
      remote: remoteUrlResolver,
      credential: () => this.#tokenProvider(),
      timeoutMs: fetchTimeoutMs,
      excludedPath: RUNTIME_EXCLUDE,
      normalizeIdentity: normalizeSha,
      errors: {
        creationDenied: (repository) => new PolicyError(`managed repository does not exist and workspace.allowCreate is false: ${repository}`),
        remoteMismatch: ({ location, remote, observedRemote }) => repositoryAdmissionError(
          'origin',
          'origin-mismatch',
          'review the managed repository origin before allowing DevBridge to reuse local state',
          {
            args: ['remote', 'get-url', 'origin'],
            cwd: location,
            exitCode: 0,
            stdout: '',
            stderr: `expected remote: ${remote}\nobserved remote: ${observedRemote}`,
          },
        ),
        defaultReference: ({ location, head }) => repositoryAdmissionError(
          'default-ref',
          'fetch-or-ref',
          'verify the requested/default ref exists and refresh the managed repository fetch state',
          {
            args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
            cwd: location,
            exitCode: head.exitCode,
            signal: head.signal,
            stdout: head.stdout,
            stderr: head.stderr,
          },
        ),
      },
    });

    this.#baseline = new BaselineAuthority({
      run: this.#run,
      channels: baselineChannels,
      defaultChannel: defaultBaselineChannel,
      errors: {
        unauthorized: (channel) => new PolicyError(`baseline channel ${channel} is not authorized by local policy`),
        unavailable: (channel, repository) => new PolicyError(`authorized baseline channel ${channel} is unavailable for ${repository}`),
        noLongerAuthorized: (channel) => new PolicyError(`persisted baseline channel ${channel} is no longer authorized by local policy`),
        channelMismatch: () => new PolicyError('persisted baseline ref does not match the locally authorized baseline channel'),
        invalidReference: () => new PolicyError('persisted baseline ref must remain an origin remote-tracking branch'),
        persistedUnavailable: (baseRef, repository) => new PolicyError(`persisted publication baseline ref ${baseRef} is unavailable for ${repository}`),
      },
    });

    this.#lifecycle = new WorktreeLifecycle({
      run: this.#run,
      assertContained: (value) => this.#workspace.assertWriteContained(value),
      errors: {
        identityMismatch: () => new PolicyError('existing run worktree identity mismatch'),
        branchMismatch: (branch) => new PolicyError(`existing worktree is on unexpected branch ${branch}`),
      },
    });

    this.#observation = new WorkspaceObservation({
      run: this.#run,
      normalizeIdentity: normalizeSha,
      reserved: isReservedRuntimePath,
      errors: {
        unmerged: (files) => new PolicyError(`worktree has unresolved merges: ${files.join(', ')}`),
        reserved: (files) => new PolicyError(`reserved DevBridge runtime paths may not become project changes: ${files.join(', ')}`),
        diffCheck: (detail) => new PolicyError(`git diff --check failed: ${detail}`),
      },
    });

    this.#sealing = new CandidateSealing({
      run: this.#run,
      observe: (workspace) => this.#observation.observe(workspace),
      validate: (workspace) => this.#observation.validate(workspace),
      reserved: isReservedRuntimePath,
      commitArguments: ({ issueNumber, revision }) => [
        '-c', 'user.name=DevBridge',
        '-c', 'user.email=devbridge@localhost',
        '-c', 'commit.gpgSign=false',
        'commit', '--no-gpg-sign', '-m', `DevBridge issue #${issueNumber} ${String(revision).slice(0, 12)}`,
      ],
      errors: {
        restore: (detail) => new PolicyError(`failed to restore DevBridge-owned candidate index after rejected seal: ${String(detail).trim()}`),
        proposal: (error) => error instanceof PolicyError ? new CandidateValidationError(error.message, { cause: error }) : error,
        reserved: (files) => new CandidateValidationError(`refusing to seal reserved DevBridge runtime paths: ${files.join(', ')}`),
        diffCheck: (detail) => new CandidateValidationError(`staged candidate failed git diff --check: ${String(detail).trim()}`),
        remainedDirty: () => new PolicyError('candidate remained dirty after DevBridge sealed it'),
      },
    });

    this.#reconciliation = new BaselineReconciliation({
      run: this.#run,
      validate: (workspace) => this.#observation.validate(workspace),
      normalizeIdentity: normalizeSha,
      rebaseArguments: ({ current, previous, branch }) => [
        '-c', 'user.name=DevBridge',
        '-c', 'user.email=devbridge@localhost',
        '-c', 'commit.gpgSign=false',
        'rebase', '--no-autostash', '--onto', current, previous, branch,
      ],
      errors: {
        historyRewrite: ({ fromBaseSha, toBaseSha, fromHeadSha, baseRef }) => new BaselineReconciliationError(
          `publication baseline ${baseRef} no longer descends from the previously verified publication baseline`,
          { kind: 'upstream-history-rewrite', reconciliation: { fromBaseSha, toBaseSha, fromHeadSha } },
        ),
        compareBaseline: (detail) => new PolicyError(`unable to compare publication baseline ancestry: ${String(detail).trim()}`),
        candidateAncestry: () => new PolicyError('candidate branch no longer descends from its persisted publication baseline'),
        compareCandidate: (detail) => new PolicyError(`unable to compare candidate ancestry: ${String(detail).trim()}`),
        abort: (detail) => new PolicyError(`automatic baseline rebase failed and DevBridge could not restore the pre-rebase candidate: ${String(detail).trim()}`),
        restoreMismatch: () => new PolicyError('automatic baseline rebase abort did not restore the exact candidate head'),
        conflict: ({ baseRef, files, fromBaseSha, toBaseSha, fromHeadSha }) => new BaselineReconciliationError(
          `automatic baseline rebase conflicted with ${baseRef}; the pre-rebase candidate was restored${files.length ? ` (${files.join(', ')})` : ''}`,
          { kind: 'conflict', files, reconciliation: { fromBaseSha, toBaseSha, fromHeadSha } },
        ),
        becameDirty: () => new PolicyError('candidate became dirty while reconciling the publication baseline'),
      },
    });

    this.#publication = new PublicationTransaction({
      run: this.#run,
      timeoutMs: fetchTimeoutMs,
      normalizeIdentity: normalizeSha,
      error: (message) => new PolicyError(message),
      unexpectedHead: (head) => new PolicyError(`remote DevBridge task branch moved to unexpected head ${head}; refusing to overwrite it`),
    });
  }

  branchName(task) {
    return `${this.#branchPrefix}/issue-${task.issueNumber}-${task.revision.slice(0, 12)}`;
  }

  worktreePath(repository, runId) {
    const [owner, name] = splitRepository(repository);
    return path.join(this.#workspace.root, 'worktrees', owner, name, safeRunId(runId));
  }

  async ensureRepository(repository) {
    return this.#admission.admit(repository);
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
      const existsBase = await this.#run(['cat-file', '-e', `${baseSha}^{commit}`], { cwd: repo.repoDir, allowFailure: true });
      if (existsBase.exitCode !== 0) throw new PolicyError(`persisted run baseline is no longer available locally: ${baseSha}`);
    } else {
      const baseline = await this.#baseline.select(repo, resume.baselineChannel ?? task.envelope.controllerPlan?.baselineChannel ?? null);
      ({ baseRef, baseSha, baselineChannel } = baseline);
    }

    const publicationBaseSha = normalizeSha(resume.publicationBaseSha ?? baseSha, 'publication baseline');
    const existsPublicationBase = await this.#run(['cat-file', '-e', `${publicationBaseSha}^{commit}`], {
      cwd: repo.repoDir,
      allowFailure: true,
    });
    if (existsPublicationBase.exitCode !== 0) {
      throw new PolicyError(`persisted publication baseline is no longer available locally: ${publicationBaseSha}`);
    }
    const taskBranchKnownRemoteHeads = this.#publication.normalizeKnown(resume.taskBranchKnownRemoteHeads);

    await this.#lifecycle.prepare({
      repositoryLocation: repo.repoDir,
      location: worktreeDir,
      branch,
      baseline: publicationBaseSha,
    });

    return {
      ...repo,
      baseRef,
      baseSha,
      baselineChannel,
      publicationBaseSha,
      taskBranchKnownRemoteHeads,
      worktreeDir,
      branch,
      runId: safeRunId(runId),
    };
  }

  async snapshot(workspace) {
    return this.#observation.observe(workspace);
  }

  async validate(workspace) {
    return this.#observation.validate(workspace);
  }

  async reconcilePublicationBaseline(workspace) {
    const before = await this.validate(workspace);
    if (before.dirty) throw new CandidateValidationError('publication baseline reconciliation requires a sealed clean candidate');
    const repo = await this.ensureRepository(workspace.repository);
    const current = await this.#baseline.observe(repo, workspace);
    return this.#reconciliation.reconcile(workspace, { before, current });
  }

  async sealCandidate(workspace, metadata) {
    await this.#sealing.seal(workspace, metadata);
    const reconciliation = await this.reconcilePublicationBaseline(workspace);
    if (reconciliation.changed) {
      throw new BaselineReverificationRequiredError(
        `upstream baseline advanced from ${reconciliation.fromBaseSha} to ${reconciliation.toBaseSha}; DevBridge rebased the sealed candidate and requires fresh verification before publication`,
        reconciliation,
      );
    }
    return reconciliation.snapshot;
  }

  async publishTaskBranch(workspace, { expectedHeadSha = null } = {}) {
    if (!workspace.branch.startsWith(`${this.#branchPrefix}/`)) throw new PolicyError('refusing to publish a non-DevBridge task branch');
    const snapshot = await this.validate(workspace);
    if (snapshot.dirty) throw new PolicyError('refusing to publish an unsealed dirty task branch');
    const credential = await this.#tokenProvider();
    return this.#publication.publish(workspace, {
      snapshot,
      expectedHeadSha,
      ref: `refs/heads/${workspace.branch}`,
      credential,
    });
  }
}
