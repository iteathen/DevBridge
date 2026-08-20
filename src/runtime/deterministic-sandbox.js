import process from 'node:process';
import { PolicyError } from '../errors.js';
import { BubblewrapSandboxProvider } from './bubblewrap-sandbox.js';
import { unavailableSandboxStatus } from './sandbox-status.js';
import { WindowsNativeAppContainerSandboxProvider } from './windows-processcontainer-compat-provider.js';

const PROVIDERS = new Set(['auto', 'bubblewrap', 'windows-processcontainer', 'none']);

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
  if (!PROVIDERS.has(provider)) throw new PolicyError('sandbox provider must be auto, bubblewrap, windows-processcontainer, or none');
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

  if (process.platform === 'linux') {
    if (normalized.provider === 'windows-processcontainer') {
      return new UnavailableSandboxProvider(unavailableSandboxStatus({
        requestedProvider: normalized.provider,
        provider: 'windows-processcontainer',
        reason: 'Windows process-container sandbox was requested on a non-Windows host',
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

  if (process.platform === 'win32') {
    if (normalized.provider === 'bubblewrap') {
      return new UnavailableSandboxProvider(unavailableSandboxStatus({
        requestedProvider: normalized.provider,
        provider: 'bubblewrap',
        reason: 'Bubblewrap sandbox was requested on a non-Linux host',
      }));
    }
    // The logical provider name remains windows-processcontainer for local
    // configuration compatibility, but the enforcement engine is DevBridge's
    // native AppContainer + Job Object boundary. The sandboxed root process is
    // assigned to the Job before it can execute, so descendants inherit the
    // lifetime boundary directly instead of relying on an outer MXC launcher.
    return new WindowsNativeAppContainerSandboxProvider({
      requestedProvider: normalized.provider,
      externalReadRoots,
      workspaceRoot,
      stateDirectory,
      env,
    });
  }

  return new UnavailableSandboxProvider(unavailableSandboxStatus({
    requestedProvider: normalized.provider,
    provider: 'none',
    reason: `no verified repository-code sandbox provider is implemented for ${process.platform}; repository-code operations are disabled`,
  }));
}
