import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

function fail(message, code = null) {
  const error = new Error(message);
  if (code) error.code = code;
  throw error;
}

function installationIdentity(home, platform) {
  if (typeof home !== 'string' || home.trim() === '') fail('DevBridge installation home is required for supervisor ownership');
  const resolved = path.resolve(home).normalize('NFC');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function runtimeSupervisorEndpoint(home, { platform = process.platform } = {}) {
  const digest = createHash('sha256')
    .update(`devbridge/runtime-supervisor-lock-v1\0${installationIdentity(home, platform)}`)
    .digest('hex')
    .slice(0, 40);
  if (platform === 'win32') return `\\\\.\\pipe\\devbridge-supervisor-${digest}`;
  if (platform === 'linux') return `\0devbridge-supervisor-${digest}`;
  fail(`DevBridge supervisor ownership is not implemented for platform ${platform}`);
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function acquireRuntimeSupervisorLock(home, {
  platform = process.platform,
  createServer = (listener) => net.createServer(listener),
} = {}) {
  const endpoint = runtimeSupervisorEndpoint(home, { platform });
  const server = createServer((socket) => socket.destroy());
  try {
    await listen(server, endpoint);
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      fail(
        'another DevBridge supervisor already owns this installation home; use its configured status/stop commands instead of starting a competing updater',
        'DEVBRIDGE_SUPERVISOR_ACTIVE',
      );
    }
    throw error;
  }

  let released = false;
  return async function releaseRuntimeSupervisorLock() {
    if (released) return;
    released = true;
    await close(server);
  };
}
