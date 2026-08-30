import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';

const SUPPORTED_PLATFORMS = Object.freeze(['linux', 'win32']);

async function canonicalIdentity(target, platform) {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) {
    throw new TypeError('exclusive mutation target is invalid');
  }
  const resolved = path.resolve(target);
  const directory = path.dirname(resolved);
  await mkdir(directory, { recursive: true });
  let canonical;
  try {
    canonical = await realpath(resolved);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    canonical = path.join(await realpath(directory), path.basename(resolved));
  }
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function endpoint(platform, digest) {
  if (platform === 'win32') return `\\\\.\\pipe\\local-mutation-v1-${digest}`;
  if (platform === 'linux') return `\0local-mutation-v1-${digest}`;
  throw new Error(`exclusive mutation is unsupported on platform ${platform}`);
}

function listen(server, address) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(address);
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export function createExclusiveMutation({
  platform = process.platform,
  listener = (onConnection) => createServer(onConnection),
  delay = pause,
  clock = () => performance.now(),
  maximumWaitMs = 5_000,
  retryDelayMs = 10,
} = {}) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) throw new Error(`exclusive mutation is unsupported on platform ${platform}`);
  if (typeof listener !== 'function' || typeof delay !== 'function' || typeof clock !== 'function') {
    throw new TypeError('exclusive mutation dependencies are incomplete');
  }
  if (!Number.isSafeInteger(maximumWaitMs) || maximumWaitMs < 0 || maximumWaitMs > 60_000) {
    throw new TypeError('exclusive mutation wait bound is invalid');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 1_000) {
    throw new TypeError('exclusive mutation retry delay is invalid');
  }

  return async function runExclusive(target, operation) {
    if (typeof operation !== 'function') throw new TypeError('exclusive mutation operation is required');
    const identity = await canonicalIdentity(target, platform);
    const digest = createHash('sha256').update(identity, 'utf8').digest('hex');
    const address = endpoint(platform, digest);
    const deadline = clock() + maximumWaitMs;
    let server;
    for (;;) {
      server = listener((connection) => connection.destroy());
      if (!server || typeof server.listen !== 'function' || typeof server.close !== 'function') {
        throw new TypeError('exclusive mutation listener is invalid');
      }
      try {
        await listen(server, address);
        break;
      } catch (error) {
        if (error?.code !== 'EADDRINUSE') throw error;
        if (clock() >= deadline) {
          const busy = new Error('exclusive mutation wait bound was exceeded');
          busy.code = 'EXCLUSIVE_MUTATION_BUSY';
          throw busy;
        }
        await delay(Math.min(retryDelayMs, Math.max(0, deadline - clock())));
      }
    }

    let leaseError = null;
    server.on('error', (error) => { leaseError ??= error; });
    try {
      const result = await operation();
      if (leaseError) throw new Error('exclusive mutation lease failed', { cause: leaseError });
      return result;
    } finally {
      await close(server);
    }
  };
}
