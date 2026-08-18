import { createHash } from 'node:crypto';
import { PolicyError } from '../errors.js';

export const DECISION_CLASSES = Object.freeze([
  'security-capability',
  'bootstrap-self-update',
  'git-github-publication',
  'workflow-release',
  'public-contract',
  'architectural-change',
]);

const DECISION_CLASS_SET = new Set(DECISION_CLASSES);
const DIGEST_RE = /^[0-9a-f]{64}$/u;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizedPath(value) {
  return String(value).replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function owners(paths) {
  const result = new Set();
  for (const value of paths) {
    const parts = normalizedPath(value).split('/');
    if (parts[0] === 'src' && parts.length >= 2) result.add(`src/${parts[1]}`);
    else result.add(parts[0]);
  }
  return result;
}

function securityCapability(file) {
  return file === 'AGENTS.md' ||
    file === 'src/config.js' ||
    file.startsWith('src/security/') ||
    /^src\/runtime\/(?:.*sandbox.*|process-runner\.js|deterministic-process-runner\.js|cli-profile\.js|profile-security\.js|worker-exchange\.js|deterministic-operation-security\.js)$/u.test(file) ||
    file === 'specs/PP-003-security.md';
}

function bootstrapSelfUpdate(file) {
  return file === 'patch-poller.mjs' ||
    file.startsWith('src/bootstrap/') ||
    file === 'docs/bootstrap.md' ||
    file === 'specs/PP-011-runtime-supervision.md';
}

function gitGithubPublication(file) {
  return file.startsWith('src/git/') ||
    file.startsWith('src/github/') ||
    file === 'specs/PP-008-git-supply-chain.md' ||
    file === 'specs/PP-010-provenance-control-channels.md';
}

function workflowRelease(file) {
  return file.startsWith('.github/workflows/');
}

function publicContract(file) {
  return file.startsWith('specs/');
}

export function classifySensitiveCandidate(changedFiles, {
  architectureFileThreshold = 20,
  architectureOwnerThreshold = 4,
} = {}) {
  if (!Array.isArray(changedFiles)) throw new PolicyError('hard-gate changedFiles must be an array');
  const paths = [...new Set(changedFiles.map(normalizedPath))].sort();
  const classes = new Set();
  const reasons = [];

  const matched = (decisionClass, predicate, description) => {
    const files = paths.filter(predicate);
    if (files.length === 0) return;
    classes.add(decisionClass);
    reasons.push({ decisionClass, description, paths: files });
  };

  matched('security-capability', securityCapability, 'security/capability policy or enforcement boundary');
  matched('bootstrap-self-update', bootstrapSelfUpdate, 'bootstrap, self-update, or runtime supervision boundary');
  matched('git-github-publication', gitGithubPublication, 'Git/GitHub credential, provenance, or publication boundary');
  matched('workflow-release', workflowRelease, 'workflow/release automation');
  matched('public-contract', publicContract, 'normative specification/public contract');

  const ownerCount = owners(paths).size;
  if (paths.length >= architectureFileThreshold || ownerCount >= architectureOwnerThreshold) {
    classes.add('architectural-change');
    reasons.push({
      decisionClass: 'architectural-change',
      description: 'broad candidate crosses local architectural breadth threshold',
      paths,
      fileCount: paths.length,
      ownerCount,
    });
  }

  return {
    required: classes.size > 0,
    decisionClasses: [...classes].sort(),
    reasons,
    changedFiles: paths,
  };
}

function normalizeDecisionClasses(classes) {
  if (!Array.isArray(classes) || classes.length === 0) throw new PolicyError('checkpoint decision classes are required');
  const normalized = [...new Set(classes.map(String))].sort();
  for (const decisionClass of normalized) {
    if (!DECISION_CLASS_SET.has(decisionClass)) throw new PolicyError(`unknown decision class ${decisionClass}`);
  }
  return normalized;
}

function normalizeScopePaths(paths) {
  if (!Array.isArray(paths)) throw new PolicyError('decision scope paths must be an array');
  return [...new Set(paths.map(normalizedPath))].sort();
}

export function decisionScopeSubjectDigest({ decisionClasses, scopePaths, bounds = {} }) {
  const classes = normalizeDecisionClasses(decisionClasses);
  const paths = normalizeScopePaths(scopePaths);
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) throw new PolicyError('decision scope bounds must be an object');
  const normalizedBounds = Object.fromEntries(Object.entries(bounds).sort(([a], [b]) => a.localeCompare(b)));
  return sha256(JSON.stringify({
    protocol: 'patch-poller/decision-scope-v1',
    decisionClasses: classes,
    scopePaths: paths,
    bounds: normalizedBounds,
  }));
}

export function checkpointIdFor({ runId, taskRevision, bindingMode, subjectDigest, decisionClasses, generation = null }) {
  if (!DIGEST_RE.test(String(taskRevision))) throw new PolicyError('checkpoint task revision is invalid');
  if (!DIGEST_RE.test(String(subjectDigest))) throw new PolicyError('checkpoint subject digest is invalid');
  if (!['artifact-exact', 'decision-scope'].includes(bindingMode)) throw new PolicyError('checkpoint binding mode is invalid');
  const classes = normalizeDecisionClasses(decisionClasses);
  const digest = sha256(JSON.stringify({
    runId: String(runId),
    taskRevision,
    bindingMode,
    subjectDigest,
    decisionClasses: classes,
    generation: generation == null ? null : String(generation),
  }));
  return `checkpoint-${digest.slice(0, 32)}`;
}

export function createHardGateCheckpoint({
  runId,
  taskRevision,
  baselineSha,
  subjectDigest,
  decisionClasses,
  reasons,
  changedFiles,
  approvalTtlMs,
  nowMs = Date.now(),
}) {
  if (!DIGEST_RE.test(String(subjectDigest))) throw new PolicyError('artifact-exact subject digest is invalid');
  if (!Number.isInteger(approvalTtlMs) || approvalTtlMs < 60_000) throw new PolicyError('decision approval TTL is invalid');
  const classes = normalizeDecisionClasses(decisionClasses);
  const checkpointId = checkpointIdFor({
    runId,
    taskRevision,
    bindingMode: 'artifact-exact',
    subjectDigest,
    decisionClasses: classes,
    generation: String(nowMs),
  });
  return {
    protocol: 'patch-poller/checkpoint-v1',
    checkpointId,
    type: 'hard-gate',
    bindingMode: 'artifact-exact',
    runId: String(runId),
    taskRevision: String(taskRevision),
    baselineSha: String(baselineSha),
    subjectDigest,
    decisionClasses: classes,
    reasons: structuredClone(reasons ?? []),
    changedFiles: normalizeScopePaths(changedFiles ?? []),
    state: 'pending',
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + approvalTtlMs).toISOString(),
    supersededAt: null,
    resolvedAt: null,
    decision: null,
  };
}

export function decisionAuthorityActors(authorities, decisionClasses) {
  const classes = normalizeDecisionClasses(decisionClasses);
  if (!authorities || typeof authorities !== 'object' || Array.isArray(authorities)) return [];
  let intersection = null;
  for (const decisionClass of classes) {
    const actors = new Set(Array.isArray(authorities[decisionClass]) ? authorities[decisionClass].map(String) : []);
    intersection = intersection == null
      ? actors
      : new Set([...intersection].filter((actorId) => actors.has(actorId)));
  }
  return [...(intersection ?? new Set())].sort();
}

export function decisionMatchesCheckpoint(checkpoint, decision, { nowMs = Date.now() } = {}) {
  if (!checkpoint || checkpoint.state !== 'pending') return { ok: false, reason: 'checkpoint-not-pending' };
  if (Date.parse(checkpoint.expiresAt) <= nowMs) return { ok: false, reason: 'checkpoint-expired' };
  if (decision.runId !== checkpoint.runId) return { ok: false, reason: 'decision-run-mismatch' };
  if (decision.taskRevision !== checkpoint.taskRevision) return { ok: false, reason: 'decision-task-mismatch' };
  if (decision.checkpointId !== checkpoint.checkpointId) return { ok: false, reason: 'decision-checkpoint-mismatch' };
  if (decision.subjectDigest !== checkpoint.subjectDigest) return { ok: false, reason: 'decision-subject-mismatch' };
  return { ok: true, reason: null };
}
