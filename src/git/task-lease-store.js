import { GitCommandError, PolicyError } from '../errors.js';
import { parseSignedTaskLease, serializeSignedTaskLease } from '../run/task-lease.js';

export const TASK_LEASE_REF_PREFIX = 'refs/heads/patch-poller-control/leases';

const SHA_RE = /^[0-9a-f]{40}$/u;
const REVISION_RE = /^[0-9a-f]{64}$/u;

function authBaseUrl(remoteUrl) {
  try { return `${new URL(remoteUrl).origin}/`; }
  catch { return null; }
}

function assertTask(task, queueRepository) {
  if (!task || typeof task !== 'object') throw new PolicyError('task lease store requires a task');
  if (task.queueRepository !== queueRepository) throw new PolicyError('task lease store task queue repository does not match local coordination repository');
  if (!Number.isSafeInteger(task.issueNumber) || task.issueNumber < 1) throw new PolicyError('task lease store issue number is invalid');
  if (typeof task.revision !== 'string' || !REVISION_RE.test(task.revision)) throw new PolicyError('task lease store revision must be a lowercase SHA-256 digest');
}

function splitLines(text) {
  return String(text).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export class GitTaskLeaseStore {
  #workspace;
  #git;
  #tokenProvider;
  #queueRepository;
  #fetchTimeoutMs;

  constructor({ workspaceManager, gitClient, tokenProvider = async () => null, queueRepository, fetchTimeoutMs = 300_000 }) {
    if (!workspaceManager || typeof workspaceManager.ensureRepository !== 'function') throw new TypeError('GitTaskLeaseStore requires a workspace manager');
    if (!gitClient || typeof gitClient.run !== 'function') throw new TypeError('GitTaskLeaseStore requires a Git client');
    if (typeof queueRepository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(queueRepository)) throw new TypeError('GitTaskLeaseStore queueRepository must be owner/name');
    this.#workspace = workspaceManager;
    this.#git = gitClient;
    this.#tokenProvider = tokenProvider;
    this.#queueRepository = queueRepository;
    this.#fetchTimeoutMs = fetchTimeoutMs;
  }

  refForTask(task) {
    assertTask(task, this.#queueRepository);
    return `${TASK_LEASE_REF_PREFIX}/issue-${task.issueNumber}/${task.revision}`;
  }

  async #repository() {
    return this.#workspace.ensureRepository(this.#queueRepository);
  }

  async observe(task) {
    const ref = this.refForTask(task);
    const repo = await this.#repository();
    const token = await this.#tokenProvider();
    const common = {
      cwd: repo.repoDir,
      token,
      authBaseUrl: authBaseUrl(repo.remoteUrl),
      timeoutMs: this.#fetchTimeoutMs,
    };
    const remote = await this.#git.run(['ls-remote', '--heads', 'origin', ref], { ...common, allowFailure: true });
    if (remote.timedOut) throw new GitCommandError('task lease observation timed out', remote);
    if (remote.exitCode !== 0) throw new GitCommandError('task lease observation failed', remote);
    const lines = splitLines(remote.stdout);
    if (lines.length === 0) return { ref, commitSha: null, envelope: null };
    if (lines.length !== 1) throw new PolicyError('task lease remote returned an ambiguous ref observation');
    const match = lines[0].match(/^([0-9a-f]{40})\s+(.+)$/u);
    if (!match || match[2] !== ref) throw new PolicyError('task lease remote returned a malformed ref observation');
    const commitSha = match[1];

    const fetched = await this.#git.run(['fetch', '--no-tags', 'origin', ref], { ...common, allowFailure: true });
    if (fetched.timedOut) throw new GitCommandError('task lease fetch timed out', fetched);
    if (fetched.exitCode !== 0) throw new GitCommandError('task lease fetch failed', fetched);
    const object = await this.#git.run(['cat-file', '-e', `${commitSha}^{commit}`], { cwd: repo.repoDir, allowFailure: true });
    if (object.exitCode !== 0) throw new PolicyError('observed task lease commit is unavailable after fetch');

    const [message, parents] = await Promise.all([
      this.#git.run(['show', '-s', '--format=%B', commitSha], { cwd: repo.repoDir }),
      this.#git.run(['show', '-s', '--format=%P', commitSha], { cwd: repo.repoDir }),
    ]);
    const envelope = parseSignedTaskLease(message.stdout);
    const parentShas = splitLines(parents.stdout).flatMap((line) => line.split(/\s+/u).filter(Boolean));
    const previous = envelope.subject.previousLeaseSha;
    if (previous == null) {
      if (parentShas.length !== 0) throw new PolicyError('initial task lease commit must not have a parent');
    } else if (parentShas.length !== 1 || parentShas[0] !== previous) {
      throw new PolicyError('task lease commit ancestry does not match its signed predecessor');
    }
    return { ref, commitSha, envelope };
  }

  async compareAndSwap(task, { expectedSha = null, envelope }) {
    const ref = this.refForTask(task);
    if (expectedSha != null && (typeof expectedSha !== 'string' || !SHA_RE.test(expectedSha))) {
      throw new PolicyError('task lease expected SHA must be null or an exact lowercase commit SHA');
    }
    if (envelope?.subject?.previousLeaseSha !== expectedSha) {
      throw new PolicyError('signed task lease predecessor must equal the CAS expected SHA');
    }
    const repo = await this.#repository();
    const token = await this.#tokenProvider();
    const common = {
      cwd: repo.repoDir,
      token,
      authBaseUrl: authBaseUrl(repo.remoteUrl),
      timeoutMs: this.#fetchTimeoutMs,
    };
    const tree = await this.#git.run(['rev-parse', `${repo.baseSha}^{tree}`], { cwd: repo.repoDir });
    const treeSha = tree.stdout.trim();
    if (!SHA_RE.test(treeSha)) throw new PolicyError('task lease store could not resolve a control commit tree');
    const commitArgs = [
      '-c', 'user.name=PATCH-POLLER',
      '-c', 'user.email=patch-poller@localhost',
      '-c', 'commit.gpgSign=false',
      'commit-tree', treeSha,
    ];
    if (expectedSha) commitArgs.push('-p', expectedSha);
    commitArgs.push('-m', serializeSignedTaskLease(envelope).trimEnd());
    const committed = await this.#git.run(commitArgs, { cwd: repo.repoDir });
    const commitSha = committed.stdout.trim();
    if (!SHA_RE.test(commitSha)) throw new PolicyError('task lease store did not create a valid commit');

    const leaseArg = `--force-with-lease=${ref}:${expectedSha ?? ''}`;
    const pushed = await this.#git.run(['push', 'origin', leaseArg, `${commitSha}:${ref}`], { ...common, allowFailure: true });
    if (!pushed.timedOut && pushed.exitCode === 0) return { updated: true, ref, commitSha, envelope };

    let current = null;
    try { current = await this.observe(task); }
    catch (error) {
      if (pushed.timedOut) throw new GitCommandError('task lease CAS push timed out and ownership could not be reconciled', { ...pushed, cause: error });
      throw new GitCommandError('task lease CAS push failed and ownership could not be reconciled', { ...pushed, cause: error });
    }
    if (current.commitSha !== expectedSha) {
      return { updated: false, reason: 'cas-lost', ref, expectedSha, attemptedSha: commitSha, current };
    }
    if (pushed.timedOut) throw new GitCommandError('task lease CAS push timed out without an observed competing update', pushed);
    throw new GitCommandError('task lease CAS push failed without an observed competing update', pushed);
  }
}
