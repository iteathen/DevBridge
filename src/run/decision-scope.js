import { PolicyError } from '../errors.js';
import { checkpointIdFor, decisionScopeSubjectDigest } from './hard-gate-policy.js';

const DIGEST_RE = /^[0-9a-f]{64}$/u;

function normalizeClasses(value) {
  if (!Array.isArray(value) || value.length === 0) throw new PolicyError('decision-scope classes are required');
  return [...new Set(value.map(String))].sort();
}

function normalizePaths(value) {
  if (!Array.isArray(value)) throw new PolicyError('decision-scope paths must be an array');
  return [...new Set(value.map((entry) => String(entry).replace(/\\/gu, '/').replace(/^\.\//u, '')))].sort();
}

export function createDecisionScopeCheckpoint({
  runId,
  taskRevision,
  baselineSha,
  decisionClasses,
  scopePaths,
  bounds = {},
  approvalTtlMs,
  nowMs = Date.now(),
}) {
  if (typeof runId !== 'string' || runId.length === 0) throw new PolicyError('decision-scope runId is required');
  if (!DIGEST_RE.test(String(taskRevision))) throw new PolicyError('decision-scope task revision is invalid');
  if (typeof baselineSha !== 'string' || !/^[0-9a-f]{40,64}$/u.test(baselineSha)) throw new PolicyError('decision-scope baseline SHA is invalid');
  if (!Number.isInteger(approvalTtlMs) || approvalTtlMs < 60_000) throw new PolicyError('decision-scope approval TTL is invalid');
  const classes = normalizeClasses(decisionClasses);
  const paths = normalizePaths(scopePaths);
  const subjectDigest = decisionScopeSubjectDigest({ decisionClasses: classes, scopePaths: paths, bounds });
  const checkpointId = checkpointIdFor({
    runId,
    taskRevision,
    bindingMode: 'decision-scope',
    subjectDigest,
    decisionClasses: classes,
    generation: String(nowMs),
  });
  return {
    protocol: 'devbridge/checkpoint-v1',
    checkpointId,
    type: 'decision-boundary',
    bindingMode: 'decision-scope',
    runId,
    taskRevision,
    baselineSha,
    subjectDigest,
    decisionClasses: classes,
    scopePaths: paths,
    bounds: structuredClone(bounds),
    state: 'pending',
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + approvalTtlMs).toISOString(),
    supersededAt: null,
    resolvedAt: null,
    decision: null,
  };
}

export function decisionScopeValidity(checkpoint, {
  decisionClasses,
  scopePaths,
  bounds = {},
  nowMs = Date.now(),
} = {}) {
  if (!checkpoint || checkpoint.bindingMode !== 'decision-scope') return { valid: false, reason: 'not-decision-scope' };
  if (checkpoint.state !== 'approved') return { valid: false, reason: 'decision-scope-not-approved' };
  if (Date.parse(checkpoint.expiresAt) <= nowMs) return { valid: false, reason: 'decision-scope-expired' };
  const currentDigest = decisionScopeSubjectDigest({ decisionClasses, scopePaths, bounds });
  if (currentDigest !== checkpoint.subjectDigest) {
    return { valid: false, reason: 'decision-scope-changed', currentDigest };
  }
  return { valid: true, reason: null, currentDigest };
}

export function invalidateDecisionScopeIfChanged(checkpoint, input, { nowMs = Date.now() } = {}) {
  const validity = decisionScopeValidity(checkpoint, { ...input, nowMs });
  if (validity.valid || validity.reason !== 'decision-scope-changed') return validity;
  checkpoint.state = 'superseded';
  checkpoint.supersededAt = new Date(nowMs).toISOString();
  checkpoint.resolvedAt = checkpoint.supersededAt;
  return validity;
}
