import process from 'node:process';
import { PolicyError } from '../errors.js';
import { BubblewrapSandboxProvider } from './bubblewrap-sandbox.js';
import { unavailableSandboxStatus } from './sandbox-status.js';

const PROVIDERS = new Set(['auto', 'bubblewrap', 'none']);

class UnavailableSandboxProvider {
  #status;

  constructor(status) {
    this.#status = status;
  }

  inspect() { return { ...this.#status }; }
  async verify() { return this.inspect(); }

  async prepareExecution() {
    throw new PolicyError(
      `repository-code execution requires a verified sandbox provider; ${this.#status.reason}`,
    );
  }
}

export function normalizeSandboxPolicy(raw = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const provider = value.provider ?? 'auto';
  if (!PROVIDERS.has(provider)) throw new PolicyError('sandbox provider must be auto, bubblewrap, or none');
  const bubblewrapExecutable = value.bubblewrapExecutable ?? 'bwrap';
  if (typeof bubblewrapExecutable !== 'string' || bubblewrapExecutable.trim() === '') {
    throw new PolicyError('bubblewrap executable must be a non-empty local executable name/path');
  }
  return { provider, bubblewrapExecutable };
}

export function createDeterministicSandboxProvider({
  policy = { provider: 'auto', bubblewrapExecutable: 'bwrap' },
  externalReadRoots = [],
  workspaceRoot,
  stateDirectory,
  env = process.env,
} = {}) {
  const normalized = normalizeSandboxPolicy(policy);
  if (normalized.provider === 'none') {
    return new UnavailableSandboxProvider(unavailableSandboxStatus({
      requestedProvider: 'none',
      reason: 'repository-code sandboxing is explicitly disabled by local policy',
    }));
  }
  if (process.platform !== 'linux') {
    return new UnavailableSandboxProvider(unavailableSandboxStatus({
      requestedProvider: normalized.provider,
      provider: normalized.provider === 'bubblewrap' ? 'bubblewrap' : 'none',
      reason: `no verified repository-code sandbox provider is implemented for ${process.platform}; repository-code operations are disabled`,
    }));
  }
  return new BubblewrapSandboxProvider({
    requestedProvider: normalized.provider,
    executable: normalized.bubblewrapExecutable,
    externalReadRoots,
    workspaceRoot,
    stateDirectory,
    env,
  });
}
