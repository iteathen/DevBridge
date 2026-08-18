import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const LOCK_PROTOCOL = 'patch-poller/daemon-lock-v1';
const STOP_PROTOCOL = 'patch-poller/daemon-stop-v1';

function stopFilePath(filePath, token) {
  return `${filePath}.stop-${token}`;
}

function validateLockRecord(record, filePath) {
  if (record?.protocol !== LOCK_PROTOCOL ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/iu.test(record.token) ||
      typeof record.createdAt !== 'string') {
    throw new PolicyError(`PATCH-POLLER daemon lock is malformed at ${filePath}`);
  }
  return record;
}

export async function readDaemonLock(filePath) {
  let text;
  try { text = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try { return validateLockRecord(JSON.parse(text), filePath); }
  catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError(`PATCH-POLLER daemon lock is malformed at ${filePath}`);
  }
}

async function readStopRequest(filePath, token) {
  const stopPath = stopFilePath(filePath, token);
  let text;
  try { text = await readFile(stopPath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let record;
  try { record = JSON.parse(text); }
  catch { throw new PolicyError(`PATCH-POLLER daemon stop request is malformed at ${stopPath}`); }
  if (record?.protocol !== STOP_PROTOCOL || record.token !== token ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      typeof record.requestedAt !== 'string') {
    throw new PolicyError(`PATCH-POLLER daemon stop request is malformed at ${stopPath}`);
  }
  return { record, stopPath };
}

export async function acquireDaemonLock(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  let handle;
  try { handle = await open(filePath, 'wx', 0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let detail = '';
    try { detail = await readFile(filePath, 'utf8'); } catch {}
    throw new PolicyError(`PATCH-POLLER daemon lock already exists at ${filePath}${detail ? `: ${detail.trim()}` : ''}`);
  }
  const record = { protocol: LOCK_PROTOCOL, pid: process.pid, token, createdAt: new Date().toISOString() };
  await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
  await handle.close();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      const current = await readDaemonLock(filePath);
      if (current && current.token !== token) {
        throw new PolicyError('daemon lock ownership changed; refusing to unlink it');
      }
      if (current) await unlink(filePath);
    } finally {
      try { await unlink(stopFilePath(filePath, token)); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  };
  Object.defineProperty(release, 'record', { value: Object.freeze({ ...record }), enumerable: false });
  return release;
}

export async function daemonStatus(filePath) {
  const lock = await readDaemonLock(filePath);
  if (!lock) return { activeLock: false, stopRequested: false };
  const stop = await readStopRequest(filePath, lock.token);
  return {
    activeLock: true,
    pid: lock.pid,
    createdAt: lock.createdAt,
    stopRequested: Boolean(stop),
  };
}

export async function requestDaemonStop(filePath) {
  const lock = await readDaemonLock(filePath);
  if (!lock) return { activeLock: false, requested: false, stopped: true };
  const stopPath = stopFilePath(filePath, lock.token);
  let handle;
  try { handle = await open(stopPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readStopRequest(filePath, lock.token);
    return {
      activeLock: true,
      requested: true,
      alreadyRequested: Boolean(existing),
      pid: lock.pid,
      createdAt: lock.createdAt,
    };
  }
  const request = {
    protocol: STOP_PROTOCOL,
    pid: lock.pid,
    token: lock.token,
    requestedAt: new Date().toISOString(),
  };
  await handle.writeFile(`${JSON.stringify(request)}\n`, 'utf8');
  await handle.close();
  return {
    activeLock: true,
    requested: true,
    alreadyRequested: false,
    pid: lock.pid,
    createdAt: lock.createdAt,
  };
}

export async function consumeDaemonStopRequest(filePath, lockRecord) {
  const stop = await readStopRequest(filePath, lockRecord.token);
  if (!stop) return false;
  if (stop.record.pid !== lockRecord.pid) {
    throw new PolicyError('daemon stop request PID does not match lock owner');
  }
  await unlink(stop.stopPath);
  return true;
}

function pause(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export async function waitForDaemonStopRequest(filePath, lockRecord, delayMs, signal = null) {
  const deadline = Date.now() + Math.max(0, delayMs);
  do {
    if (signal?.aborted) return false;
    if (await consumeDaemonStopRequest(filePath, lockRecord)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await pause(Math.min(250, remaining), signal);
  } while (Date.now() < deadline);
  return false;
}

export async function stopDaemon(filePath, { timeoutMs = 15000, pollMs = 100 } = {}) {
  const request = await requestDaemonStop(filePath);
  if (!request.activeLock) return request;
  const lock = await readDaemonLock(filePath);
  if (!lock) return { ...request, stopped: true };
  const token = lock.token;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    const current = await readDaemonLock(filePath);
    if (!current) return { ...request, stopped: true };
    if (current.token !== token) {
      throw new PolicyError('daemon lock ownership changed while waiting for stop');
    }
  }
  return { ...request, stopped: false };
}
