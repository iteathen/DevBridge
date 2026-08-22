import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const LOCK_PROTOCOL = 'devbridge/daemon-lock-v1';
const STOP_PROTOCOL = 'devbridge/daemon-stop-v1';
const PAUSE_PROTOCOL = 'devbridge/daemon-pause-v1';
const PAUSED_PROTOCOL = 'devbridge/daemon-paused-v1';

function stopFilePath(filePath, token) { return `${filePath}.stop-${token}`; }
function pauseFilePath(filePath, token) { return `${filePath}.pause-${token}`; }
function pausedFilePath(filePath, token) { return `${filePath}.paused-${token}`; }

async function unlinkIfExists(filePath) {
  try { await unlink(filePath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function validateLockRecord(record, filePath) {
  if (record?.protocol !== LOCK_PROTOCOL ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/iu.test(record.token) ||
      typeof record.createdAt !== 'string') {
    throw new PolicyError(`DevBridge daemon lock is malformed at ${filePath}`);
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
    throw new PolicyError(`DevBridge daemon lock is malformed at ${filePath}`);
  }
}

async function readControlRecord(recordPath, { protocol, token, kind, timestampField }) {
  let text;
  try { text = await readFile(recordPath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let record;
  try { record = JSON.parse(text); }
  catch { throw new PolicyError(`DevBridge daemon ${kind} record is malformed at ${recordPath}`); }
  if (record?.protocol !== protocol || record.token !== token ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      typeof record[timestampField] !== 'string') {
    throw new PolicyError(`DevBridge daemon ${kind} record is malformed at ${recordPath}`);
  }
  return { record, recordPath };
}

async function readStopRequest(filePath, token) {
  return readControlRecord(stopFilePath(filePath, token), { protocol: STOP_PROTOCOL, token, kind: 'stop request', timestampField: 'requestedAt' });
}
async function readPauseRequest(filePath, token) {
  return readControlRecord(pauseFilePath(filePath, token), { protocol: PAUSE_PROTOCOL, token, kind: 'pause request', timestampField: 'requestedAt' });
}
async function readPausedAcknowledgement(filePath, token) {
  return readControlRecord(pausedFilePath(filePath, token), { protocol: PAUSED_PROTOCOL, token, kind: 'pause acknowledgement', timestampField: 'pausedAt' });
}

async function publishControlRecord(recordPath, record) {
  const tempPath = `${recordPath}.tmp-${randomUUID()}`;
  let handle = null;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await rename(tempPath, recordPath);
      return true;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      try { await readFile(recordPath, 'utf8'); }
      catch (readError) {
        if (readError?.code === 'ENOENT') throw error;
        throw readError;
      }
      return false;
    }
  } finally {
    if (handle) { try { await handle.close(); } catch {} }
    await unlinkIfExists(tempPath);
  }
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
    throw new PolicyError(`DevBridge daemon lock already exists at ${filePath}${detail ? `: ${detail.trim()}` : ''}`);
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
      if (current && current.token !== token) throw new PolicyError('daemon lock ownership changed; refusing to unlink it');
      if (current) await unlink(filePath);
    } finally {
      await unlinkIfExists(stopFilePath(filePath, token));
      await unlinkIfExists(pauseFilePath(filePath, token));
      await unlinkIfExists(pausedFilePath(filePath, token));
    }
  };
  Object.defineProperty(release, 'record', { value: Object.freeze({ ...record }), enumerable: false });
  return release;
}

export async function daemonStatus(filePath) {
  const lock = await readDaemonLock(filePath);
  if (!lock) return { activeLock: false, stopRequested: false, pauseRequested: false, paused: false };
  const [stop, pauseRequest, paused] = await Promise.all([
    readStopRequest(filePath, lock.token),
    readPauseRequest(filePath, lock.token),
    readPausedAcknowledgement(filePath, lock.token),
  ]);
  for (const control of [stop, pauseRequest, paused]) {
    if (control && control.record.pid !== lock.pid) throw new PolicyError('daemon control record PID does not match lock owner');
  }
  return {
    activeLock: true,
    pid: lock.pid,
    createdAt: lock.createdAt,
    stopRequested: Boolean(stop),
    pauseRequested: Boolean(pauseRequest),
    paused: Boolean(paused),
  };
}

async function createDaemonStopRequest(filePath) {
  const lock = await readDaemonLock(filePath);
  if (!lock) return { result: { activeLock: false, requested: false, stopped: true }, token: null };
  const existing = await readStopRequest(filePath, lock.token);
  if (existing) {
    return {
      result: { activeLock: true, requested: true, alreadyRequested: true, pid: lock.pid, createdAt: lock.createdAt },
      token: lock.token,
    };
  }
  const request = { protocol: STOP_PROTOCOL, pid: lock.pid, token: lock.token, requestedAt: new Date().toISOString() };
  const published = await publishControlRecord(stopFilePath(filePath, lock.token), request);
  if (!published) {
    const raced = await readStopRequest(filePath, lock.token);
    return {
      result: { activeLock: true, requested: true, alreadyRequested: Boolean(raced), pid: lock.pid, createdAt: lock.createdAt },
      token: lock.token,
    };
  }
  return {
    result: { activeLock: true, requested: true, alreadyRequested: false, pid: lock.pid, createdAt: lock.createdAt },
    token: lock.token,
  };
}

async function createDaemonPauseRequest(filePath) {
  const lock = await readDaemonLock(filePath);
  if (!lock) return { result: { activeLock: false, requested: false, paused: false }, token: null };
  const existing = await readPauseRequest(filePath, lock.token);
  if (existing) {
    const paused = await readPausedAcknowledgement(filePath, lock.token);
    return {
      result: {
        activeLock: true,
        requested: true,
        alreadyRequested: true,
        paused: Boolean(paused),
        pid: lock.pid,
        createdAt: lock.createdAt,
      },
      token: lock.token,
    };
  }
  const request = { protocol: PAUSE_PROTOCOL, pid: lock.pid, token: lock.token, requestedAt: new Date().toISOString() };
  const published = await publishControlRecord(pauseFilePath(filePath, lock.token), request);
  if (!published) {
    const raced = await readPauseRequest(filePath, lock.token);
    const paused = await readPausedAcknowledgement(filePath, lock.token);
    return {
      result: {
        activeLock: true,
        requested: Boolean(raced),
        alreadyRequested: Boolean(raced),
        paused: Boolean(paused),
        pid: lock.pid,
        createdAt: lock.createdAt,
      },
      token: lock.token,
    };
  }
  return {
    result: { activeLock: true, requested: true, alreadyRequested: false, paused: false, pid: lock.pid, createdAt: lock.createdAt },
    token: lock.token,
  };
}

export async function requestDaemonStop(filePath) { return (await createDaemonStopRequest(filePath)).result; }
export async function requestDaemonPause(filePath) { return (await createDaemonPauseRequest(filePath)).result; }

export async function consumeDaemonStopRequest(filePath, lockRecord) {
  const stop = await readStopRequest(filePath, lockRecord.token);
  if (!stop) return false;
  if (stop.record.pid !== lockRecord.pid) throw new PolicyError('daemon stop request PID does not match lock owner');
  await unlink(stop.recordPath);
  return true;
}

export async function hasDaemonPauseRequest(filePath, lockRecord) {
  const request = await readPauseRequest(filePath, lockRecord.token);
  if (!request) return false;
  if (request.record.pid !== lockRecord.pid) throw new PolicyError('daemon pause request PID does not match lock owner');
  return true;
}

export async function acknowledgeDaemonPause(filePath, lockRecord) {
  if (!(await hasDaemonPauseRequest(filePath, lockRecord))) return false;
  const existing = await readPausedAcknowledgement(filePath, lockRecord.token);
  if (existing) {
    if (existing.record.pid !== lockRecord.pid) throw new PolicyError('daemon pause acknowledgement PID does not match lock owner');
    return true;
  }
  const record = { protocol: PAUSED_PROTOCOL, pid: lockRecord.pid, token: lockRecord.token, pausedAt: new Date().toISOString() };
  await publishControlRecord(pausedFilePath(filePath, lockRecord.token), record);
  if (!(await hasDaemonPauseRequest(filePath, lockRecord))) {
    await clearDaemonPauseAcknowledgement(filePath, lockRecord);
    return false;
  }
  return true;
}

export async function clearDaemonPauseAcknowledgement(filePath, lockRecord) {
  const acknowledgement = await readPausedAcknowledgement(filePath, lockRecord.token);
  if (!acknowledgement) return false;
  if (acknowledgement.record.pid !== lockRecord.pid) throw new PolicyError('daemon pause acknowledgement PID does not match lock owner');
  await unlink(acknowledgement.recordPath);
  return true;
}

function pause(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => finish();
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) finish();
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

export async function waitForDaemonControlRequest(filePath, lockRecord, delayMs, signal = null) {
  const deadline = Date.now() + Math.max(0, delayMs);
  do {
    if (signal?.aborted) return null;
    if (await consumeDaemonStopRequest(filePath, lockRecord)) return 'stop-requested';
    if (await hasDaemonPauseRequest(filePath, lockRecord)) return 'pause-requested';
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await pause(Math.min(250, remaining), signal);
  } while (Date.now() < deadline);
  return null;
}

export async function waitForDaemonResumeOrStop(filePath, lockRecord, signal = null, { pollMs = 250 } = {}) {
  while (!signal?.aborted) {
    if (await consumeDaemonStopRequest(filePath, lockRecord)) return 'stop-requested';
    if (!(await hasDaemonPauseRequest(filePath, lockRecord))) return 'resumed';
    await pause(Math.max(10, pollMs), signal);
  }
  return 'signal';
}

export async function stopDaemon(filePath, { timeoutMs = 15000, pollMs = 100 } = {}) {
  const requested = await createDaemonStopRequest(filePath);
  if (!requested.result.activeLock) return requested.result;
  const token = requested.token;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    const current = await readDaemonLock(filePath);
    if (!current) return { ...requested.result, stopped: true };
    if (current.token !== token) throw new PolicyError('daemon lock ownership changed while waiting for stop');
  }
  return { ...requested.result, stopped: false };
}

export async function pauseDaemon(filePath, { timeoutMs = 15000, pollMs = 100 } = {}) {
  const requested = await createDaemonPauseRequest(filePath);
  if (!requested.result.activeLock || requested.result.paused) return requested.result;
  const token = requested.token;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    const current = await readDaemonLock(filePath);
    if (!current) return { ...requested.result, activeLock: false, paused: false, stopped: true };
    if (current.token !== token) throw new PolicyError('daemon lock ownership changed while waiting for pause');
    const acknowledgement = await readPausedAcknowledgement(filePath, token);
    if (acknowledgement) {
      if (acknowledgement.record.pid !== current.pid) throw new PolicyError('daemon pause acknowledgement PID does not match lock owner');
      return { ...requested.result, paused: true };
    }
  }
  return { ...requested.result, paused: false };
}

export async function resumeDaemon(filePath, { timeoutMs = 15000, pollMs = 100 } = {}) {
  const lock = await readDaemonLock(filePath);
  if (!lock) return { activeLock: false, resumed: true, pauseRequested: false, paused: false };
  const request = await readPauseRequest(filePath, lock.token);
  if (request) {
    if (request.record.pid !== lock.pid) throw new PolicyError('daemon pause request PID does not match lock owner');
    await unlink(request.recordPath);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readDaemonLock(filePath);
    if (!current) return { activeLock: false, resumed: true, pauseRequested: false, paused: false };
    if (current.token !== lock.token) throw new PolicyError('daemon lock ownership changed while waiting for resume');
    const acknowledgement = await readPausedAcknowledgement(filePath, lock.token);
    const currentRequest = await readPauseRequest(filePath, lock.token);
    if (!acknowledgement && !currentRequest) {
      const confirmed = await readDaemonLock(filePath);
      if (!confirmed) return { activeLock: false, resumed: true, pauseRequested: false, paused: false };
      if (confirmed.token !== lock.token) throw new PolicyError('daemon lock ownership changed while confirming resume');
      return { activeLock: true, pid: confirmed.pid, resumed: true, pauseRequested: false, paused: false };
    }
    await pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  const status = await daemonStatus(filePath);
  return { ...status, resumed: status.activeLock && !status.pauseRequested && !status.paused };
}
