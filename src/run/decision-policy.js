import { ConfigurationError } from '../errors.js';

const CLASS_RE = /^[A-Za-z0-9_.:-]{1,80}$/u;

export function normalizeDecisionPolicy(raw = {}, { fallbackActorIds = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigurationError('decisions must be an object');
  const configured = raw.authorityClasses ?? { 'security-change': fallbackActorIds };
  if (!configured || typeof configured !== 'object' || Array.isArray(configured) || Object.keys(configured).length === 0 || Object.keys(configured).length > 32) {
    throw new ConfigurationError('decisions.authorityClasses must contain 1-32 locally configured classes');
  }
  const authorityClasses = {};
  for (const [name, actorIds] of Object.entries(configured)) {
    if (!CLASS_RE.test(name)) throw new ConfigurationError(`decision authority class is invalid: ${name}`);
    if (!Array.isArray(actorIds) || actorIds.length === 0 || actorIds.length > 64 || actorIds.some((entry) => !/^\d+$/u.test(String(entry)))) {
      throw new ConfigurationError(`decisions.authorityClasses.${name} must contain 1-64 numeric GitHub user IDs`);
    }
    authorityClasses[name] = [...new Set(actorIds.map(String))];
  }
  const checkpointTtlMs = raw.checkpointTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(checkpointTtlMs) || checkpointTtlMs < 60_000 || checkpointTtlMs > 365 * 24 * 60 * 60 * 1000) {
    throw new ConfigurationError('decisions.checkpointTtlMs must be between one minute and one year');
  }
  return { authorityClasses, checkpointTtlMs };
}
