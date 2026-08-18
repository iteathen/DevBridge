import { BubblewrapSandboxProvider } from './bubblewrap-sandbox-provider.js';
import { WindowsSandboxProvider } from './windows-sandbox-provider.js';

export function createExecutionSandboxProvider(config = {}, { env = process.env, protectedRoots = [] } = {}) {
  const provider = config.provider ?? 'auto';
  if (provider === 'none') return null;
  if (provider === 'bubblewrap' || (provider === 'auto' && process.platform === 'linux')) {
    return new BubblewrapSandboxProvider({
      config: { executable: config.bubblewrapExecutable ?? 'bwrap', readRoots: config.readRoots ?? [], verificationTimeoutMs: config.verificationTimeoutMs },
      env,
      protectedRoots,
    });
  }
  if (provider === 'windows-sandbox' || (provider === 'auto' && process.platform === 'win32')) {
    return new WindowsSandboxProvider({
      config: { executable: config.windowsSandboxExecutable ?? 'wsb', readRoots: config.readRoots ?? [], verificationTimeoutMs: config.verificationTimeoutMs },
      env,
      protectedRoots,
    });
  }
  return null;
}
