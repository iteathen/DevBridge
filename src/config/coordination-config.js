import { ConfigurationError } from '../errors.js';
import { importAgentPublicIdentity, validateAgentHandle } from '../security/agent-identity.js';

const ALLOWED_KEYS = new Set(['enabled', 'handle', 'leaseTtlMs', 'heartbeatIntervalMs', 'clockSkewMs', 'trustedPeers']);
const PEER_KEYS = new Set(['handle', 'publicKeySpki']);

function integer(value, name, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigurationError(`${name} must be a safe integer between ${min} and ${max}`);
  return value;
}

function bool(value, name) {
  if (typeof value !== 'boolean') throw new ConfigurationError(`${name} must be a boolean`);
  return value;
}

export function normalizeCoordinationConfig(raw = {}, { pollIntervalMs = 60_000 } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigurationError('coordination must be an object');
  for (const key of Object.keys(raw)) if (!ALLOWED_KEYS.has(key)) throw new ConfigurationError(`coordination.${key} is not supported`);
  const enabled = raw.enabled == null ? false : bool(raw.enabled, 'coordination.enabled');
  let handle;
  try { handle = validateAgentHandle(raw.handle ?? 'agent', 'coordination.handle'); }
  catch (error) { throw new ConfigurationError(error.message, { cause: error }); }
  const leaseTtlMs = integer(raw.leaseTtlMs ?? 1_200_000, 'coordination.leaseTtlMs', { min: 120_000, max: 86_400_000 });
  const heartbeatIntervalMs = integer(raw.heartbeatIntervalMs ?? 300_000, 'coordination.heartbeatIntervalMs', { min: 10_000, max: 21_600_000 });
  const clockSkewMs = integer(raw.clockSkewMs ?? 60_000, 'coordination.clockSkewMs', { min: 0, max: 300_000 });
  if (heartbeatIntervalMs >= leaseTtlMs) throw new ConfigurationError('coordination.heartbeatIntervalMs must be less than coordination.leaseTtlMs');
  if (heartbeatIntervalMs * 2 > leaseTtlMs) throw new ConfigurationError('coordination.leaseTtlMs must be at least twice coordination.heartbeatIntervalMs');
  if (enabled && leaseTtlMs < (2 * pollIntervalMs) + clockSkewMs) {
    throw new ConfigurationError('coordination.leaseTtlMs must cover at least two normal poll intervals plus clock skew');
  }

  const rawPeers = raw.trustedPeers ?? [];
  if (!Array.isArray(rawPeers) || rawPeers.length > 32) throw new ConfigurationError('coordination.trustedPeers must contain at most 32 peers');
  const trustedPeers = [];
  const fingerprints = new Set();
  for (let index = 0; index < rawPeers.length; index += 1) {
    const peer = rawPeers[index];
    if (!peer || typeof peer !== 'object' || Array.isArray(peer)) throw new ConfigurationError(`coordination.trustedPeers[${index}] must be an object`);
    for (const key of Object.keys(peer)) if (!PEER_KEYS.has(key)) throw new ConfigurationError(`coordination.trustedPeers[${index}].${key} is not supported`);
    let imported;
    try { imported = importAgentPublicIdentity(peer); }
    catch (error) { throw new ConfigurationError(`coordination.trustedPeers[${index}] is invalid: ${error.message}`, { cause: error }); }
    if (fingerprints.has(imported.fingerprint)) throw new ConfigurationError(`coordination.trustedPeers duplicates fingerprint ${imported.fingerprint}`);
    fingerprints.add(imported.fingerprint);
    trustedPeers.push({
      handle: imported.handle,
      fingerprint: imported.fingerprint,
      address: imported.address,
      publicKeySpki: imported.publicKeySpki,
    });
  }

  return { enabled, handle, leaseTtlMs, heartbeatIntervalMs, clockSkewMs, trustedPeers };
}
