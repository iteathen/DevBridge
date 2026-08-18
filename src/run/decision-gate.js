import { createHash } from 'node:crypto';
import { PolicyError } from '../errors.js';

const DIGEST_RE = /^[0-9a-f]{64}$/u;
const SENSITIVE_PREFIXES = [
  '.github/actions/', '.github/workflows/', 'src/bootstrap/', 'src/git/', 'src/github/', 'src/security/',
];
const SENSITIVE_EXACT = new Set([
  'src/config.js', 'src/runtime/cli-profile.js', 'src/runtime/process-runner.js',
  'src/runtime/deterministic-process-runner.js', 'src/runtime/deterministic-operation-registry.js',
  'src/runtime/execution-sandbox.js', 'src/runtime/sandbox-provider.js',
  'specs/PP-003-security.md', 'specs/PP-007-human-checkpoints.md', 'specs/PP-008-git-supply-chain.md',
  'specs/PP-010-provenance-control-channels.md', 'specs/PP-011-runtime-supervision.md', 'docs/bootstrap.md',
]);

function sha256(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex'); }
function normalizedPath(value) { return String(value).replace(/\\/gu, '/').replace(/^\.\//u, ''); }

export function classifySensitiveCandidate(changedFiles) {
  const paths = [...new Set((changedFiles ?? []).map(normalizedPath))].sort();
  const sensitivePaths = paths.filter((file) => SENSITIVE_EXACT.has(file) || SENSITIVE_PREFIXES.some((prefix) => file.startsWith(prefix)) || /(^|\/)sandbox[^/]*\.[cm]?[jt]s$/u.test(file));
  return sensitivePaths.length === 0 ? null : {
    decisionClass: 'security-change',
    bindingMode: 'artifact-exact',
    sensitivePaths,
    rationale: 'Candidate changes security, bootstrap, Git/GitHub, workflow, or capability-control surfaces.',
  };
}

export function normalizeDecisionScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new PolicyError('decision scope must be an object');
  const decisionClass = String(scope.decisionClass ?? '');
  if (!/^[A-Za-z0-9_.:-]{1,80}$/u.test(decisionClass)) throw new PolicyError('decision scope class is invalid');
  const boundaries = [...new Set((scope.boundaries ?? []).map((entry) => String(entry).trim()).filter(Boolean))].sort();
  if (boundaries.length === 0 || boundaries.length > 64 || boundaries.some((entry) => Buffer.byteLength(entry, 'utf8') > 256)) throw new PolicyError('decision scope boundaries are invalid');
  const summary = String(scope.summary ?? '').trim();
  if (!summary || Buffer.byteLength(summary, 'utf8') > 4000) throw new PolicyError('decision scope summary is invalid');
  return { decisionClass, boundaries, summary };
}

export function decisionSubjectDigest({ bindingMode, artifactDigest = null, decisionScope = null }) {
  if (bindingMode === 'artifact-exact') {
    if (!DIGEST_RE.test(artifactDigest ?? '')) throw new PolicyError('artifact-exact decision requires an artifact digest');
    return sha256({ bindingMode, artifactDigest });
  }
  if (bindingMode === 'decision-scope') {
    const normalized = normalizeDecisionScope(decisionScope);
    return sha256({ bindingMode, scope: normalized });
  }
  throw new PolicyError('unsupported decision binding mode');
}

export function checkpointIdFor({ runId, taskRevision, decisionClass, bindingMode, subjectDigest }) {
  return `gate-${sha256({ runId, taskRevision, decisionClass, bindingMode, subjectDigest }).slice(0, 20)}`;
}

export function decisionIsAccepted({ checkpoint, decision, allowedActorIds, nowMs = Date.now() }) {
  if (!checkpoint || !decision) return { accepted: false, reason: 'missing' };
  if (checkpoint.state === 'superseded') return { accepted: false, reason: 'superseded' };
  if (checkpoint.expiresAt && Date.parse(checkpoint.expiresAt) <= nowMs) return { accepted: false, reason: 'expired' };
  if (decision.runId !== checkpoint.runId) return { accepted: false, reason: 'run-mismatch' };
  if (decision.taskRevision !== checkpoint.taskRevision) return { accepted: false, reason: 'task-mismatch' };
  if (decision.checkpointId !== checkpoint.checkpointId) return { accepted: false, reason: 'checkpoint-mismatch' };
  if (decision.subjectDigest !== checkpoint.subjectDigest) return { accepted: false, reason: 'subject-mismatch' };
  if (!allowedActorIds.has(String(decision.actorId ?? ''))) return { accepted: false, reason: 'actor-not-authorized' };
  return { accepted: true, reason: null };
}
