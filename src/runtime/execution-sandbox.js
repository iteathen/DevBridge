import { PolicyError } from '../errors.js';

const UNAVAILABLE = Object.freeze({
  provider: 'none',
  configured: false,
  verified: false,
  filesystem: false,
  network: false,
  workerIdentity: false,
  reason: 'no execution sandbox provider is configured',
});

function normalizeStatus(raw, fallbackProvider = 'unknown') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...UNAVAILABLE, provider: fallbackProvider, configured: fallbackProvider !== 'none', reason: 'sandbox provider returned no verifiable status' };
  }
  return {
    provider: typeof raw.provider === 'string' && raw.provider ? raw.provider : fallbackProvider,
    configured: raw.configured !== false,
    verified: raw.verified === true,
    filesystem: raw.filesystem === true,
    network: raw.network === true,
    workerIdentity: raw.workerIdentity === true,
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : null,
  };
}

export function sandboxStatus(provider) {
  if (!provider) return { ...UNAVAILABLE };
  try {
    const value = typeof provider.status === 'function' ? provider.status() : null;
    if (value && typeof value.then === 'function') {
      return {
        ...UNAVAILABLE,
        provider: provider.name ?? 'unknown',
        configured: true,
        reason: 'sandbox provider status requires asynchronous verification',
      };
    }
    return normalizeStatus(value, provider.name ?? 'unknown');
  } catch (error) {
    return {
      ...UNAVAILABLE,
      provider: provider.name ?? 'unknown',
      configured: true,
      reason: `sandbox status failed: ${error.message}`,
    };
  }
}

export async function verifySandboxProvider(provider) {
  if (!provider) return { ...UNAVAILABLE };
  try {
    const raw = typeof provider.verify === 'function'
      ? await provider.verify()
      : (typeof provider.status === 'function' ? await provider.status() : null);
    return normalizeStatus(raw, provider.name ?? 'unknown');
  } catch (error) {
    return {
      ...UNAVAILABLE,
      provider: provider.name ?? 'unknown',
      configured: true,
      reason: `sandbox verification failed: ${error.message}`,
    };
  }
}

export function assertVerifiedRepositorySandbox(status, operation = 'repository-code execution') {
  if (status?.verified !== true || status.filesystem !== true || status.network !== true || status.workerIdentity !== true) {
    const provider = status?.provider ?? 'none';
    const reason = status?.reason ? `: ${status.reason}` : '';
    throw new PolicyError(`${operation} requires a verified filesystem/network/worker-identity sandbox; provider ${provider} is not sufficient${reason}`);
  }
}
