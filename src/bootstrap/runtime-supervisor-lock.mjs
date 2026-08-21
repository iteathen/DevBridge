import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const CLAIM_PROTOCOL = 'devbridge/runtime-supervisor-claim-v1';
const TOKEN = /^[0-9a-f-]{36}$/iu;

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

function installationDigest(home, platform) {
  return createHash('sha256')
    .update(`devbridge/runtime-supervisor-lock-v1\0${installationIdentity(home, platform)}`)
    .digest('hex')
    .slice(0, 40);
}

export function runtimeSupervisorEndpoint(home, { platform = process.platform } = {}) {
  const digest = installationDigest(home, platform);
  if (platform === 'win32') return `\\\\.\\pipe\\devbridge-supervisor-${digest}`;
  if (platform === 'linux') return `\0devbridge-supervisor-${digest}`;
  fail(`DevBridge supervisor ownership is not implemented for platform ${platform}`);
}

export function runtimeSupervisorClaimFile(home) {
  return path.join(path.resolve(home), 'runtime-supervisor-claim.json');
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

function defaultIsProcessAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function validateClaim(value, file) {
  const fields = Object.keys(value ?? {}).sort().join(',');
  if (
    fields !== 'acquiredAt,installationDigest,pid,protocol,token' ||
    value.protocol !== CLAIM_PROTOCOL ||
    !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    typeof value.token !== 'string' || !TOKEN.test(value.token) ||
    typeof value.installationDigest !== 'string' || !/^[0-9a-f]{40}$/u.test(value.installationDigest) ||
    typeof value.acquiredAt !== 'string' || Number.isNaN(Date.parse(value.acquiredAt))
  ) {
    fail(`DevBridge supervisor claim is malformed at ${file}`);
  }
  return value;
}

async function readClaim(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let value;
  try { value = JSON.parse(text); }
  catch { fail(`DevBridge supervisor claim is malformed at ${file}`); }
  return validateClaim(value, file);
}

async function writeClaim(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameClaim(left, right) {
  return left?.protocol === right?.protocol &&
    left?.pid === right?.pid &&
    left?.token === right?.token &&
    left?.installationDigest === right?.installationDigest &&
    left?.acquiredAt === right?.acquiredAt;
}

async function acquireClaim(home, platform, isProcessAlive) {
  await mkdir(path.resolve(home), { recursive: true, mode: 0o700 });
  const file = runtimeSupervisorClaimFile(home);
  const digest = installationDigest(home, platform);
  const existing = await readClaim(file);
  if (existing) {
    if (existing.installationDigest !== digest) fail('DevBridge supervisor claim does not match this installation home');
    if (isProcessAlive(existing.pid)) {
      fail(
        'another DevBridge supervisor already owns this installation home; use its configured status/stop commands instead of starting a competing updater',
        'DEVBRIDGE_SUPERVISOR_ACTIVE',
      );
    }
    const observed = await readClaim(file);
    if (!sameClaim(existing, observed)) fail('DevBridge supervisor claim changed during dead-owner reconciliation');
    await unlink(file);
  }
  const claim = {
    protocol: CLAIM_PROTOCOL,
    pid: process.pid,
    token: randomUUID(),
    installationDigest: digest,
    acquiredAt: new Date().toISOString(),
  };
  try { await writeClaim(file, claim); }
  catch (error) {
    if (error?.code === 'EEXIST') {
      fail('another DevBridge supervisor won the installation-home ownership race', 'DEVBRIDGE_SUPERVISOR_ACTIVE');
    }
    throw error;
  }
  return { file, claim };
}

async function releaseClaim(file, expected) {
  const observed = await readClaim(file);
  if (!sameClaim(expected, observed)) fail('DevBridge supervisor claim ownership changed; refusing to remove it');
  await unlink(file);
}

export async function acquireRuntimeSupervisorLock(home, {
  platform = process.platform,
  createServer = (listener) => net.createServer(listener),
  isProcessAlive = defaultIsProcessAlive,
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

  let owned;
  try {
    owned = await acquireClaim(home, platform, isProcessAlive);
  } catch (error) {
    await close(server);
    throw error;
  }

  let released = false;
  return async function releaseRuntimeSupervisorLock() {
    if (released) return;
    released = true;
    try {
      await releaseClaim(owned.file, owned.claim);
    } finally {
      await close(server);
    }
  };
}
