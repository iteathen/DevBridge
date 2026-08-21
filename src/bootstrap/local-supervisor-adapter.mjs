import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const CLAIM_PROTOCOL = 'devbridge/supervisor-claim-v1';
const RECOVERY_PROTOCOL = 'devbridge/supervisor-recovery-v1';
const CONTROL_PROTOCOL = 'devbridge/supervisor-control-v1';
const RESPONSE_PROTOCOL = 'devbridge/supervisor-control-result-v1';
const MAX_CONTROL_BYTES = 4096;
const CONTROL_TIMEOUT_MS = 1500;
const STOP_TIMEOUT_MS = 20_000;

function fail(message) { throw new Error(message); }
function now() { return new Date().toISOString(); }
function sha256(value) { return createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function exactUuid(value) { return typeof value === 'string' && /^[0-9a-f-]{36}$/iu.test(value); }
function exactIdentity(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value); }

function canonicalInstallationHome(home, platform = process.platform) {
  const resolved = path.resolve(String(home));
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  let canonical = realpathSync.native(resolved);
  if (platform === 'win32') canonical = canonical.toLowerCase();
  return canonical;
}

export function installationIdentity(home, { platform = process.platform } = {}) {
  return sha256(`devbridge/installation-v1\0${canonicalInstallationHome(home, platform)}`);
}

function controlEndpoint(identity, { platform = process.platform, tempDirectory = os.tmpdir() } = {}) {
  if (platform === 'win32') return `\\\\.\\pipe\\devbridge-supervisor-${identity}`;
  return path.join(tempDirectory, `devbridge-supervisor-${identity}.sock`);
}

function claimPath(home) { return path.join(path.resolve(home), '.supervisor-claim.json'); }
function recoveryPath(home) { return path.join(path.resolve(home), '.supervisor-recovery.json'); }

function validateClaim(record, identity) {
  if (record?.protocol !== CLAIM_PROTOCOL || record.installation !== identity ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      !exactUuid(record.token) || !exactUuid(record.generation) ||
      typeof record.createdAt !== 'string') {
    fail(`supervisor ownership claim is malformed for installation ${identity.slice(0, 16)}`);
  }
  return record;
}

function validateRecovery(record, identity) {
  if (record?.protocol !== RECOVERY_PROTOCOL || record.installation !== identity ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      !exactUuid(record.token) || typeof record.createdAt !== 'string') {
    fail(`supervisor ownership recovery is ambiguous for installation ${identity.slice(0, 16)}`);
  }
  return record;
}

async function readJsonIfPresent(filePath) {
  let text;
  try { text = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try { return JSON.parse(text); }
  catch { fail('supervisor ownership record is malformed'); }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function unlinkIfPresent(filePath) {
  try { await unlink(filePath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

async function acquireRecoveryGuard(home, identity, { processAliveFn = processIsAlive } = {}) {
  await mkdir(path.resolve(home), { recursive: true, mode: 0o700 });
  const filePath = recoveryPath(home);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    let handle;
    try {
      handle = await open(filePath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({
        protocol: RECOVERY_PROTOCOL,
        installation: identity,
        pid: process.pid,
        token,
        createdAt: now(),
      })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      return async () => {
        const current = await readJsonIfPresent(filePath);
        if (!current) return;
        const record = validateRecovery(current, identity);
        if (record.pid !== process.pid || record.token !== token) {
          fail(`supervisor recovery ownership changed for installation ${identity.slice(0, 16)}`);
        }
        await unlinkIfPresent(filePath);
      };
    } catch (error) {
      if (handle) { try { await handle.close(); } catch {} }
      if (error?.code !== 'EEXIST') throw error;
      const current = validateRecovery(await readJsonIfPresent(filePath), identity);
      if (processAliveFn(current.pid)) {
        fail(`supervisor ownership recovery is already in progress for installation ${identity.slice(0, 16)}`);
      }
      await unlinkIfPresent(filePath);
    }
  }
  fail(`could not serialize supervisor ownership recovery for installation ${identity.slice(0, 16)}`);
}

function sendControl(endpoint, claim, action, { timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const socket = net.createConnection(endpoint);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ state: 'unreachable', reason: 'timeout' }), timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        protocol: CONTROL_PROTOCOL,
        action,
        installation: claim.installation,
        token: claim.token,
        generation: claim.generation,
      })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_CONTROL_BYTES) return finish({ state: 'ambiguous', reason: 'oversized-response' });
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); }
      catch { return finish({ state: 'ambiguous', reason: 'malformed-response' }); }
      if (response?.protocol !== RESPONSE_PROTOCOL ||
          response.installation !== claim.installation ||
          response.token !== claim.token ||
          response.generation !== claim.generation ||
          response.pid !== claim.pid) {
        return finish({ state: 'ambiguous', reason: 'ownership-proof-mismatch' });
      }
      finish({ state: 'proved', response });
    });
    socket.once('error', (error) => {
      if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code)) {
        finish({ state: 'unreachable', reason: error.code });
      } else {
        finish({ state: 'ambiguous', reason: error?.code ?? error?.message ?? 'socket-error' });
      }
    });
  });
}

function createControlServer(claim, signalController) {
  return net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_CONTROL_BYTES) {
        answer({ protocol: RESPONSE_PROTOCOL, installation: claim.installation, pid: claim.pid, token: claim.token, generation: claim.generation, accepted: false });
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let request;
      try { request = JSON.parse(buffer.slice(0, newline)); }
      catch { request = null; }
      const exact = request?.protocol === CONTROL_PROTOCOL &&
        request.installation === claim.installation &&
        request.token === claim.token &&
        request.generation === claim.generation;
      if (!exact) {
        answer({ protocol: RESPONSE_PROTOCOL, installation: claim.installation, pid: claim.pid, token: claim.token, generation: claim.generation, accepted: false });
        return;
      }
      if (request.action === 'stop') signalController.abort();
      answer({
        protocol: RESPONSE_PROTOCOL,
        installation: claim.installation,
        pid: claim.pid,
        token: claim.token,
        generation: claim.generation,
        accepted: request.action === 'probe' || request.action === 'stop',
        stopping: signalController.signal.aborted,
      });
    });
    socket.once('error', () => {});
  });
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function inspectClaim(home, identity, adapterOptions = {}) {
  const filePath = claimPath(home);
  const raw = await readJsonIfPresent(filePath);
  if (!raw) return { claim: null, proof: { state: 'unreachable', reason: 'no-claim' } };
  const claim = validateClaim(raw, identity);
  const endpoint = controlEndpoint(identity, adapterOptions);
  const proof = await sendControl(endpoint, claim, 'probe', adapterOptions);
  return { claim, proof, endpoint };
}

export async function observeInstallationOwner(home, adapterOptions = {}) {
  const identity = installationIdentity(home, adapterOptions);
  const { claim, proof } = await inspectClaim(home, identity, adapterOptions);
  if (!claim) return Object.freeze({ installation: identity, claimed: false, live: false });
  return Object.freeze({
    installation: identity,
    claimed: true,
    live: proof.state === 'proved' && proof.response.accepted === true,
    ambiguous: proof.state === 'ambiguous',
    pid: claim.pid,
    generation: claim.generation,
  });
}

export async function acquireInstallationOwner(home, adapterOptions = {}) {
  const identity = installationIdentity(home, adapterOptions);
  const releaseRecovery = await acquireRecoveryGuard(home, identity, adapterOptions);
  let server = null;
  let claim = null;
  let endpoint = null;
  try {
    const observed = await inspectClaim(home, identity, adapterOptions);
    if (observed.claim) {
      if (observed.proof.state === 'proved' && observed.proof.response.accepted === true) {
        fail(`supervisor already owns installation ${identity.slice(0, 16)} generation=${observed.claim.generation}`);
      }
      const processAliveFn = adapterOptions.processAliveFn ?? processIsAlive;
      if (observed.proof.state === 'ambiguous' || processAliveFn(observed.claim.pid)) {
        fail(`supervisor ownership is ambiguous for installation ${identity.slice(0, 16)} generation=${observed.claim.generation}`);
      }
      await unlinkIfPresent(claimPath(home));
    }

    endpoint = controlEndpoint(identity, adapterOptions);
    if (adapterOptions.platform !== 'win32' && process.platform !== 'win32') {
      // A dead Unix-domain owner can leave the filesystem endpoint behind.
      // Recovery is serialized by the installation recovery guard above.
      await unlinkIfPresent(endpoint);
    }

    claim = Object.freeze({
      protocol: CLAIM_PROTOCOL,
      installation: identity,
      pid: process.pid,
      token: randomUUID(),
      generation: randomUUID(),
      createdAt: now(),
    });
    const claimFile = claimPath(home);
    let claimHandle = null;
    try {
      claimHandle = await open(claimFile, 'wx', 0o600);
      await claimHandle.writeFile(`${JSON.stringify(claim)}\n`, 'utf8');
      await claimHandle.sync();
      await claimHandle.close();
      claimHandle = null;
    } finally {
      if (claimHandle) { try { await claimHandle.close(); } catch {} }
    }

    const signalController = new AbortController();
    server = createControlServer(claim, signalController);
    try {
      await listen(server, endpoint);
    } catch (error) {
      await unlinkIfPresent(claimFile);
      if (error?.code === 'EADDRINUSE') {
        fail(`supervisor singleton endpoint is already owned or ambiguous for installation ${identity.slice(0, 16)}`);
      }
      throw error;
    }

    await releaseRecovery();
    let released = false;
    return Object.freeze({
      installation: identity,
      generation: claim.generation,
      pid: claim.pid,
      signal: signalController.signal,
      async release() {
        if (released) return;
        released = true;
        const releaseGuard = await acquireRecoveryGuard(home, identity, adapterOptions);
        try {
          if (server) await closeServer(server);
          const current = await readJsonIfPresent(claimPath(home));
          if (current) {
            const record = validateClaim(current, identity);
            if (record.token !== claim.token || record.generation !== claim.generation || record.pid !== claim.pid) {
              fail(`supervisor ownership changed before release for installation ${identity.slice(0, 16)}`);
            }
            await unlinkIfPresent(claimPath(home));
          }
          if (adapterOptions.platform !== 'win32' && process.platform !== 'win32') await unlinkIfPresent(endpoint);
        } finally {
          await releaseGuard();
        }
      },
    });
  } catch (error) {
    if (server?.listening) {
      try { await closeServer(server); } catch {}
    }
    if (claim) {
      const current = await readJsonIfPresent(claimPath(home));
      if (current?.token === claim.token && current?.generation === claim.generation) await unlinkIfPresent(claimPath(home));
    }
    if (endpoint && adapterOptions.platform !== 'win32' && process.platform !== 'win32') {
      try { await unlinkIfPresent(endpoint); } catch {}
    }
    try { await releaseRecovery(); } catch {}
    throw error;
  }
}

export async function requestInstallationOwnerStop(home, adapterOptions = {}) {
  const identity = installationIdentity(home, adapterOptions);
  const { claim, proof, endpoint } = await inspectClaim(home, identity, adapterOptions);
  if (!claim) return Object.freeze({ installation: identity, requested: false, stopped: true });
  if (proof.state !== 'proved' || proof.response.accepted !== true) {
    fail(`cannot prove live supervisor ownership for installation ${identity.slice(0, 16)}; refusing stop takeover`);
  }
  const requested = await sendControl(endpoint, claim, 'stop', adapterOptions);
  if (requested.state !== 'proved' || requested.response.accepted !== true) {
    fail(`supervisor stop request was not acknowledged for installation ${identity.slice(0, 16)}`);
  }
  const deadline = Date.now() + (adapterOptions.stopTimeoutMs ?? STOP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const current = await readJsonIfPresent(claimPath(home));
    if (!current) return Object.freeze({ installation: identity, requested: true, stopped: true, generation: claim.generation });
    const validated = validateClaim(current, identity);
    if (validated.token !== claim.token || validated.generation !== claim.generation) {
      fail(`supervisor ownership changed while waiting for stop for installation ${identity.slice(0, 16)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return Object.freeze({ installation: identity, requested: true, stopped: false, generation: claim.generation });
}

export function backgroundChildOptions(options = {}) {
  return Object.freeze({
    ...options,
    windowsHide: true,
  });
}
