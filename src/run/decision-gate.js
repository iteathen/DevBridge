import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function buildCandidateManifest(workspace, snapshot) {
  const root = path.resolve(workspace.worktreeDir);
  const entries = [];
  for (const relative of [...snapshot.changedFiles].sort()) {
    const absolute = path.resolve(root, relative);
    if (!isWithin(root, absolute)) throw new PolicyError(`candidate manifest path escaped worktree: ${relative}`);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new PolicyError(`candidate manifest refuses symbolic-link change: ${relative}`);
      if (!info.isFile()) throw new PolicyError(`candidate manifest supports only regular files and deletions: ${relative}`);
      const bytes = await readFile(absolute);
      entries.push({ path: relative.replace(/\\/gu, '/'), state: 'file', bytes: bytes.length, sha256: sha256(bytes) });
    } catch (error) {
      if (error?.code === 'ENOENT') entries.push({ path: relative.replace(/\\/gu, '/'), state: 'deleted', bytes: 0, sha256: null });
      else throw error;
    }
  }
  const manifest = {
    protocol: 'patch-poller/candidate-manifest-v1',
    baseSha: workspace.baseSha,
    entries,
  };
  return { manifest, digest: sha256(stableJson(manifest)) };
}

export function decisionScopeDigest({ decisionClass, baselineSha, bounds }) {
  return sha256(stableJson({
    protocol: 'patch-poller/decision-scope-v1',
    decisionClass,
    baselineSha,
    bounds: [...new Set(bounds ?? [])].sort(),
  }));
}

export function decisionSubjectMatches(checkpoint, { artifactDigest = null, scopeDigest = null } = {}) {
  if (checkpoint?.bindingMode === 'artifact-exact') return checkpoint.subjectDigest === artifactDigest;
  if (checkpoint?.bindingMode === 'decision-scope') return checkpoint.subjectDigest === scopeDigest;
  return false;
}

export function classifySensitiveCandidate(changedFiles) {
  const paths = changedFiles.map((value) => String(value).replace(/\\/gu, '/'));
  const any = (predicate) => paths.some(predicate);
  if (any((file) => file === 'AGENTS.md' || file.startsWith('src/security/') || file === 'src/config.js' || file.includes('sandbox') || file === 'specs/PP-003-security.md')) return 'security-policy';
  if (any((file) => file === 'patch-poller.mjs' || file.startsWith('src/bootstrap/') || file === 'docs/bootstrap.md' || file === 'specs/PP-011-runtime-supervision.md')) return 'bootstrap-self-update';
  if (any((file) => file.startsWith('.github/') || file.startsWith('src/git/') || file.startsWith('src/github/') || file === 'src/app/runtime.js')) return 'git-github-control';
  if (any((file) => file.startsWith('specs/') || file === 'package.json')) return 'public-contract';
  const roots = new Set(paths.map((file) => file.split('/')[0]));
  if (paths.length >= 20 || roots.size >= 6) return 'architecture-change';
  return null;
}

function checkpointId({ runId, taskRevision, decisionClass, subjectDigest }) {
  return `cp-${sha256(`${runId}\0${taskRevision}\0${decisionClass}\0${subjectDigest}`).slice(0, 32)}`;
}

export class DecisionGate {
  #source;
  #authority;
  #ttlMs;
  #now;

  constructor({ decisionSource = null, authorityClasses = {}, ttlMs = 7 * 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.#source = decisionSource;
    this.#authority = Object.fromEntries(Object.entries(authorityClasses).map(([key, values]) => [key, new Set(values.map(String))]));
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  async evaluate({ state, task, workspace, snapshot }) {
    const decisionClass = classifySensitiveCandidate(snapshot.changedFiles);
    if (!decisionClass || snapshot.changedFiles.length === 0) return { allowed: true, decisionClass: null, checkpoint: null, manifest: null };

    const candidate = await buildCandidateManifest(workspace, snapshot);
    state.checkpoints ??= [];
    state.lastDecisionCommentId ??= 0;
    let checkpoint = [...state.checkpoints].reverse().find((entry) => entry.decisionClass === decisionClass && !['superseded'].includes(entry.status));
    const nowMs = this.#now();

    if (checkpoint && checkpoint.subjectDigest !== candidate.digest) {
      checkpoint.status = 'superseded';
      checkpoint.supersededAt = new Date(nowMs).toISOString();
      checkpoint = null;
    }
    if (!checkpoint) {
      const createdAt = new Date(nowMs).toISOString();
      checkpoint = {
        protocol: 'patch-poller/checkpoint-v1',
        checkpointId: checkpointId({ runId: state.runId, taskRevision: task.revision, decisionClass, subjectDigest: candidate.digest }),
        runId: state.runId,
        taskRevision: task.revision,
        decisionClass,
        bindingMode: 'artifact-exact',
        subjectDigest: candidate.digest,
        baselineSha: workspace.baseSha,
        affectedPaths: candidate.manifest.entries.map((entry) => entry.path),
        status: 'pending',
        createdAt,
        expiresAt: new Date(nowMs + this.#ttlMs).toISOString(),
      };
      state.checkpoints.push(checkpoint);
    }

    if (Date.parse(checkpoint.expiresAt) <= nowMs && checkpoint.status === 'pending') {
      checkpoint.status = 'expired';
      checkpoint.expiredAt = new Date(nowMs).toISOString();
    }
    if (checkpoint.status === 'approved') {
      if (!decisionSubjectMatches(checkpoint, { artifactDigest: candidate.digest })) {
        checkpoint.status = 'superseded';
        return this.evaluate({ state, task, workspace, snapshot });
      }
      return { allowed: true, decisionClass, checkpoint, manifest: candidate };
    }
    if (['rejected', 'redirected', 'expired'].includes(checkpoint.status)) {
      return { allowed: false, decisionClass, checkpoint, manifest: candidate, outcome: checkpoint.status };
    }

    const authorizedActorIds = [...(this.#authority[decisionClass] ?? new Set())];
    if (this.#source && authorizedActorIds.length > 0) {
      const polled = await this.#source.pollDecision({
        issueNumber: task.issueNumber,
        runId: state.runId,
        taskRevision: task.revision,
        checkpointId: checkpoint.checkpointId,
        subjectDigest: checkpoint.subjectDigest,
        authorizedActorIds,
        afterCommentId: state.lastDecisionCommentId ?? 0,
      });
      state.lastDecisionCommentId = polled.highestCommentId ?? state.lastDecisionCommentId ?? 0;
      if (polled.decision) {
        checkpoint.decision = {
          action: polled.decision.action,
          actorId: polled.decision.actorId,
          commentId: polled.decision.commentId,
          contentSha256: polled.decision.contentSha256,
          instructions: polled.decision.instructions ?? null,
          acceptedAt: new Date(nowMs).toISOString(),
        };
        if (polled.decision.action === 'approve') checkpoint.status = 'approved';
        else if (polled.decision.action === 'reject') checkpoint.status = 'rejected';
        else checkpoint.status = 'redirected';
      }
    }

    return {
      allowed: checkpoint.status === 'approved',
      decisionClass,
      checkpoint,
      manifest: candidate,
      outcome: checkpoint.status,
    };
  }
}
