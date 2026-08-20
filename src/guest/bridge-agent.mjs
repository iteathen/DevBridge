import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL = 'devbridge/environment-bridge-v1';
const VERSION = '1.0.0';
const RECORD_PROTOCOL = 'devbridge/environment-bridge-operation-v1';
const TRANSFER_PROTOCOL = 'devbridge/environment-bridge-transfer-v1';
const FEATURES = Object.freeze(['health', 'execute', 'observe', 'cancel', 'put', 'get']);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const REQUEST_ID = /^[a-f0-9]{32}$/u;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const CLASSES = new Set(['input', 'work', 'output', 'scratch', 'cache']);
const EXECUTION_CLASSES = new Set(['work', 'scratch', 'cache']);
const ARGUMENT_CLASSES = new Set(['input', 'work', 'output', 'scratch', 'cache']);
const PUT_CLASSES = new Set(['input', 'work', 'scratch', 'cache']);
const GET_CLASSES = new Set(['output', 'work', 'scratch', 'cache']);
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
const MAX_STDIN_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 28_800_000;
const SELF = fileURLToPath(import.meta.url);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function boundedString(value, name, { allowEmpty = false, maxBytes = 8_192 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new TypeError(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} string`);
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is not bounded`);
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function safeTarget(value) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) throw new TypeError('bridge target is invalid');
  const expected = process.env.DEVBRIDGE_GUEST_TARGET;
  if (expected && value !== expected) throw new Error('bridge target does not match this guest binding');
  return value;
}

function safeRequest(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new TypeError('bridge request identity is invalid');
  return value;
}

function safeRelative(value, name, { allowRoot = false } = {}) {
  const text = boundedString(value ?? (allowRoot ? '.' : ''), name, { maxBytes: 4_096 }).replace(/\\/gu, '/');
  if (text.startsWith('/') || text.startsWith('//') || /^[A-Za-z]:/u.test(text) || text.includes(':')) throw new TypeError(`${name} must be portable and relative`);
  const segments = text.split('/');
  if (segments.some((segment) => segment === '..' || segment.length === 0)) throw new TypeError(`${name} contains an invalid segment`);
  if (!allowRoot && segments.every((segment) => segment === '.')) throw new TypeError(`${name} must identify a non-root item`);
  return segments.filter((segment) => segment !== '.').join('/') || '.';
}

function normalizeLocation(raw, name, allowed, { allowRoot = false } = {}) {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['class', 'path']), name);
  if (typeof value.class !== 'string' || !allowed.has(value.class)) throw new TypeError(`${name}.class is invalid`);
  return { class: value.class, path: safeRelative(value.path ?? (allowRoot ? '.' : ''), `${name}.path`, { allowRoot }) };
}

function normalizeOperation(raw) {
  const value = requireObject(raw, 'bridge operation');
  onlyKeys(value, new Set(['program', 'arguments', 'directory', 'environment', 'input', 'timeoutMs', 'maxOutputBytes']), 'bridge operation');
  if (typeof value.program !== 'string' || !SAFE_NAME.test(value.program) || value.program.includes('/') || value.program.includes('\\')) throw new TypeError('bridge operation.program is invalid');
  if (!Array.isArray(value.arguments) || value.arguments.length > 256) throw new TypeError('bridge operation.arguments is invalid');
  const argumentsList = value.arguments.map((entry, index) => {
    if (typeof entry === 'string') return boundedString(entry, `bridge operation.arguments[${index}]`, { allowEmpty: true, maxBytes: 65_536 });
    return normalizeLocation(entry, `bridge operation.arguments[${index}]`, ARGUMENT_CLASSES);
  });
  const rawEnvironment = requireObject(value.environment ?? {}, 'bridge operation.environment');
  if (Object.keys(rawEnvironment).length > 128) throw new TypeError('bridge operation.environment is too large');
  const environment = {};
  for (const [key, entry] of Object.entries(rawEnvironment)) {
    if (!ENV_NAME.test(key)) throw new TypeError(`bridge operation.environment.${key} name is invalid`);
    environment[key] = boundedString(entry, `bridge operation.environment.${key}`, { allowEmpty: true, maxBytes: 16_384 });
  }
  return {
    program: value.program,
    arguments: argumentsList,
    directory: normalizeLocation(value.directory, 'bridge operation.directory', EXECUTION_CLASSES, { allowRoot: true }),
    environment,
    input: value.input == null ? null : boundedString(value.input, 'bridge operation.input', { allowEmpty: true, maxBytes: MAX_STDIN_BYTES }),
    timeoutMs: integer(value.timeoutMs, 'bridge operation.timeoutMs', 1_000, MAX_TIMEOUT_MS),
    maxOutputBytes: integer(value.maxOutputBytes, 'bridge operation.maxOutputBytes', 1_024, MAX_OUTPUT_BYTES),
  };
}

function canonicalBase64(value, name, maxBytes) {
  const text = boundedString(value, name, { allowEmpty: true, maxBytes: Math.ceil(maxBytes * 4 / 3) + 16 });
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== text) throw new TypeError(`${name} is not canonical bounded base64`);
  return bytes;
}

function rootDirectory() {
  const configured = process.env.DEVBRIDGE_GUEST_BRIDGE_ROOT;
  if (configured) return path.resolve(configured);
  if (process.platform === 'win32') {
    const base = process.env.ProgramData || 'C:\\ProgramData';
    return path.join(base, 'DevBridge', 'bridge');
  }
  return '/var/lib/devbridge/bridge';
}

const ROOT = rootDirectory();
const OPERATIONS = path.join(ROOT, '.operations');
const TRANSFERS = path.join(ROOT, '.transfers');

async function ensureDirectory(directory, name) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} must be a real directory`);
  return realpath(directory);
}

async function ensureRoot() {
  const root = await ensureDirectory(ROOT, 'bridge root');
  for (const name of CLASSES) await ensureDirectory(path.join(root, name), `bridge ${name} root`);
  await ensureDirectory(OPERATIONS, 'bridge operation root');
  await ensureDirectory(TRANSFERS, 'bridge transfer root');
  return root;
}

async function safeClassRoot(name) {
  await ensureRoot();
  const directory = path.join(ROOT, name);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('bridge class root shape changed');
  return realpath(directory);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function resolveLocation(raw, allowed, { allowRoot = false, createParents = false, requireFile = false } = {}) {
  const location = normalizeLocation(raw, 'bridge location', allowed, { allowRoot });
  const root = await safeClassRoot(location.class);
  const segments = location.path === '.' ? [] : location.path.split('/');
  let current = root;
  const parentSegments = requireFile || !allowRoot ? segments.slice(0, -1) : segments;
  for (const segment of parentSegments) {
    const next = path.join(current, segment);
    let info;
    try { info = await lstat(next); }
    catch (error) {
      if (error?.code !== 'ENOENT' || !createParents) throw error;
      await mkdir(next, { mode: 0o700 });
      info = await lstat(next);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('bridge path parent must be a real directory');
    current = await realpath(next);
    if (!contained(root, current)) throw new Error('bridge path escaped its class root');
  }
  const candidate = segments.length === 0 ? root : path.join(root, ...segments);
  if (!contained(root, path.resolve(candidate))) throw new Error('bridge path escaped its class root');
  if (requireFile) {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('bridge source must be a real regular file');
    const actual = await realpath(candidate);
    if (!contained(root, actual)) throw new Error('bridge source escaped its class root');
    return { location, root, path: actual };
  }
  if (segments.length > 0 && !createParents) {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error('bridge path must not be a symbolic link');
  }
  const parent = segments.length === 0 ? root : await realpath(path.dirname(candidate));
  if (!contained(root, parent)) throw new Error('bridge destination parent escaped its class root');
  return { location, root, path: candidate };
}

function digestObject(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

async function atomicJson(file, value) {
  await ensureRoot();
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, file); return; }
      catch (error) {
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code) || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function exclusiveJson(file, value) {
  await ensureRoot();
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  return true;
}

async function readJson(file, name) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error(`${name} is invalid`);
  return JSON.parse(await readFile(file, 'utf8'));
}

function operationFile(request) { return path.join(OPERATIONS, `${safeRequest(request)}.json`); }
function cancelFile(request) { return path.join(OPERATIONS, `${safeRequest(request)}.cancel.json`); }
function monitorFile(request) { return path.join(OPERATIONS, `${safeRequest(request)}.monitor.json`); }
function transferFile(request) { return path.join(TRANSFERS, `${safeRequest(request)}.part`); }
function transferMeta(request) { return path.join(TRANSFERS, `${safeRequest(request)}.json`); }

async function loadOperation(request) {
  await ensureRoot();
  try { return await readJson(operationFile(request), 'bridge operation record'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function validateOperationRecord(record, request, target, body = null) {
  const value = requireObject(record, 'bridge operation record');
  if (value.protocol !== RECORD_PROTOCOL || value.request !== request || value.target !== target || !['planned', 'attempting', 'running', 'completed', 'failed'].includes(value.state)) throw new Error('bridge operation record identity is invalid');
  if (body && value.digest !== digestObject(body)) throw new Error('bridge request identity was reused for a different operation');
  return value;
}

function resultState(record) {
  if (record.state === 'completed') return { state: 'completed', result: record.result, reason: null };
  if (record.state === 'failed') return { state: 'failed', result: null, reason: boundedString(record.reason ?? 'bridge operation failed', 'bridge operation failure', { maxBytes: 2_048 }) };
  if (record.state === 'planned') return { state: 'planned', result: null, reason: null };
  const monitorPid = Number(record.monitorPid);
  if (!Number.isSafeInteger(monitorPid) || monitorPid <= 0) return { state: 'indeterminate', result: null, reason: 'bridge operation monitor identity is unavailable' };
  try { process.kill(monitorPid, 0); return { state: 'running', result: null, reason: null }; }
  catch (error) {
    if (error?.code === 'EPERM') return { state: 'running', result: null, reason: null };
    return { state: 'indeterminate', result: null, reason: 'bridge operation monitor is no longer observable' };
  }
}

async function terminateTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: false, windowsHide: true });
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
      timer.unref?.();
      child.once('error', () => { clearTimeout(timer); resolve(); });
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); }
  catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const hard = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }, 1_000);
  hard.unref?.();
}

async function cancellationReason(request) {
  try {
    const value = await readJson(cancelFile(request), 'bridge cancellation record');
    return value?.reason === 'timeout' ? 'timeout' : value?.reason === 'abort' ? 'abort' : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function baseEnvironment() {
  const names = process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];
  const environment = {};
  for (const name of names) if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  return environment;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

async function monitorClaim(request) {
  try { return await readJson(monitorFile(request), 'bridge operation monitor claim'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function reserveMonitor(request) {
  const file = monitorFile(request);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const createdAt = Date.now();
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify({ token, state: 'starting', pid: process.pid, createdAt })}\n`, 'utf8'); }
      finally { await handle.close(); }
      return { token, reserved: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const claim = await monitorClaim(request);
      if (!claim || typeof claim !== 'object') throw new Error('bridge operation monitor claim is invalid');
      const age = Date.now() - Number(claim.createdAt ?? 0);
      if ((claim.state === 'active' && processAlive(Number(claim.pid))) || (claim.state === 'starting' && Number.isFinite(age) && age >= 0 && age < 10_000)) {
        return { token: null, reserved: false };
      }
      const record = await loadOperation(request);
      if (!record || record.state !== 'planned') return { token: null, reserved: false };
      await rm(file, { force: true });
    }
  }
  return { token: null, reserved: false };
}

async function activateMonitor(request, token) {
  const claim = await monitorClaim(request);
  if (!claim || claim.token !== token || claim.state !== 'starting') throw new Error('bridge operation monitor claim does not match');
  await atomicJson(monitorFile(request), { token, state: 'active', pid: process.pid, createdAt: claim.createdAt });
}

async function runOperation(request, token) {
  await activateMonitor(request, token);
  const record = await loadOperation(request);
  if (!record) throw new Error('bridge operation record is absent');
  validateOperationRecord(record, request, record.target);
  if (record.state === 'completed' || record.state === 'failed') { await rm(monitorFile(request), { force: true }); return; }
  const body = normalizeOperation(record.body);
  record.state = 'attempting';
  record.monitorPid = process.pid;
  record.attemptedAt = new Date().toISOString();
  await atomicJson(operationFile(request), record);

  const preCancelled = await cancellationReason(request);
  if (preCancelled) {
    const now = new Date().toISOString();
    record.state = 'completed';
    record.result = { exitCode: null, signal: null, timedOut: preCancelled === 'timeout', aborted: preCancelled === 'abort', outputTruncated: false, stdout: '', stderr: '', startedAt: null, finishedAt: now, lastOutputAt: null };
    record.finishedAt = now;
    await atomicJson(operationFile(request), record);
    await rm(cancelFile(request), { force: true });
    await rm(monitorFile(request), { force: true });
    return;
  }

  const working = await resolveLocation(body.directory, EXECUTION_CLASSES, { allowRoot: true, createParents: true });
  const argumentsList = [];
  for (const argument of body.arguments) {
    if (typeof argument === 'string') { argumentsList.push(argument); continue; }
    const createParents = argument.class !== 'input';
    const resolved = await resolveLocation(argument, ARGUMENT_CLASSES, { createParents, requireFile: argument.class === 'input' });
    argumentsList.push(resolved.path);
  }
  const stdout = [];
  const stderr = [];
  const capture = { bytes: 0, truncated: false, lastOutputAt: null };
  let timedOut = false;
  let spawnFailure = null;
  let settled = false;
  let child;
  const append = (list, chunk) => {
    const bytes = Buffer.from(chunk);
    capture.lastOutputAt = new Date().toISOString();
    if (capture.bytes >= body.maxOutputBytes) { capture.truncated = true; return; }
    const remaining = body.maxOutputBytes - capture.bytes;
    if (bytes.length > remaining) { list.push(bytes.subarray(0, remaining)); capture.bytes = body.maxOutputBytes; capture.truncated = true; return; }
    list.push(bytes); capture.bytes += bytes.length;
  };

  try {
    child = spawn(body.program, argumentsList, {
      cwd: working.path,
      env: { ...baseEnvironment(), ...body.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    spawnFailure = error;
  }
  if (spawnFailure) {
    record.state = 'failed';
    record.reason = String(spawnFailure.message ?? 'bridge operation could not start').slice(0, 2_048);
    record.finishedAt = new Date().toISOString();
    await atomicJson(operationFile(request), record);
    await rm(monitorFile(request), { force: true });
    return;
  }

  record.state = 'running';
  record.childPid = child.pid;
  record.startedAt = new Date().toISOString();
  await atomicJson(operationFile(request), record);

  const timer = setTimeout(async () => {
    timedOut = true;
    try { await atomicJson(cancelFile(request), { reason: 'timeout' }); } catch {}
    await terminateTree(child.pid);
  }, body.timeoutMs);
  timer.unref?.();

  const completion = new Promise((resolve) => {
    const finish = async (exitCode, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        record.state = 'failed';
        record.reason = String(error.message ?? 'bridge operation process failed').slice(0, 2_048);
        record.finishedAt = new Date().toISOString();
        await atomicJson(operationFile(request), record);
        await rm(monitorFile(request), { force: true });
        resolve();
        return;
      }
      const reason = timedOut ? 'timeout' : await cancellationReason(request);
      const finishedAt = new Date().toISOString();
      record.state = 'completed';
      record.finishedAt = finishedAt;
      record.result = {
        exitCode: exitCode == null ? null : Math.max(-1, Math.min(255, Number(exitCode))),
        signal: signal == null ? null : String(signal).slice(0, 128),
        timedOut: reason === 'timeout',
        aborted: reason === 'abort',
        outputTruncated: capture.truncated,
        stdout: Buffer.concat(stdout).toString('base64'),
        stderr: Buffer.concat(stderr).toString('base64'),
        startedAt: record.startedAt,
        finishedAt,
        lastOutputAt: capture.lastOutputAt,
      };
      await atomicJson(operationFile(request), record);
      await rm(cancelFile(request), { force: true });
      await rm(monitorFile(request), { force: true });
      resolve();
    };
    child.stdout.on('data', (chunk) => append(stdout, chunk));
    child.stderr.on('data', (chunk) => append(stderr, chunk));
    child.once('error', (error) => void finish(null, null, error));
    child.once('close', (code, signal) => void finish(code, signal));
  });

  if (body.input == null) child.stdin.end();
  else child.stdin.end(body.input);
  await completion;
}

async function execute(frame) {
  const body = normalizeOperation(frame.body);
  let record = await loadOperation(frame.request);
  if (record) {
    validateOperationRecord(record, frame.request, frame.target, body);
    if (record.state === 'planned') return ensureMonitor(frame.request, record);
    return resultState(record);
  }
  const candidate = {
    protocol: RECORD_PROTOCOL,
    request: frame.request,
    target: frame.target,
    digest: digestObject(body),
    body,
    state: 'planned',
    createdAt: new Date().toISOString(),
    monitorPid: null,
    childPid: null,
    result: null,
    reason: null,
  };
  if (!(await exclusiveJson(operationFile(frame.request), candidate))) {
    record = await loadOperation(frame.request);
    validateOperationRecord(record, frame.request, frame.target, body);
    if (record.state === 'planned') return ensureMonitor(frame.request, record);
    return resultState(record);
  }
  record = candidate;
  return ensureMonitor(frame.request, record);
}

async function ensureMonitor(request, record) {
  const reservation = await reserveMonitor(request);
  if (!reservation.reserved) return resultState(record);
  try {
    const monitor = spawn(process.execPath, [SELF, '--run-operation', request, reservation.token], {
      stdio: 'ignore', shell: false, windowsHide: true, detached: true, env: process.env,
    });
    await new Promise((resolve, reject) => {
      monitor.once('spawn', resolve);
      monitor.once('error', reject);
    });
    monitor.unref();
  } catch (error) {
    await rm(monitorFile(request), { force: true });
    record.state = 'failed';
    record.reason = String(error.message ?? 'bridge operation monitor could not start').slice(0, 2_048);
    await atomicJson(operationFile(request), record);
    return resultState(record);
  }
  return resultState(record);
}

async function observe(frame) {
  onlyKeys(requireObject(frame.body, 'bridge observe body'), new Set(), 'bridge observe body');
  let observed = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const record = await loadOperation(frame.request);
    if (!record) return { state: 'absent', result: null, reason: null };
    validateOperationRecord(record, frame.request, frame.target);
    observed = resultState(record);
    if (observed.state !== 'indeterminate' || observed.reason !== 'bridge operation monitor is no longer observable') return observed;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return observed;
}

async function cancel(frame) {
  const body = requireObject(frame.body, 'bridge cancel body');
  onlyKeys(body, new Set(['reason']), 'bridge cancel body');
  if (!['abort', 'timeout'].includes(body.reason)) throw new TypeError('bridge cancellation reason is invalid');
  const record = await loadOperation(frame.request);
  if (!record) return { state: 'absent' };
  validateOperationRecord(record, frame.request, frame.target);
  if (record.state === 'completed') return { state: 'completed' };
  if (record.state === 'failed') return { state: 'indeterminate' };
  await atomicJson(cancelFile(frame.request), { reason: body.reason });
  if (Number.isSafeInteger(Number(record.childPid)) && Number(record.childPid) > 0) await terminateTree(Number(record.childPid));
  return { state: 'running' };
}

async function put(frame) {
  const body = requireObject(frame.body, 'bridge put body');
  onlyKeys(body, new Set(['destination', 'offset', 'data', 'eof', 'digest']), 'bridge put body');
  const destination = normalizeLocation(body.destination, 'bridge put destination', PUT_CLASSES);
  const offset = integer(body.offset, 'bridge put offset', 0, MAX_TRANSFER_BYTES);
  const data = canonicalBase64(body.data ?? '', 'bridge put data', MAX_CHUNK_BYTES);
  if (typeof body.eof !== 'boolean') throw new TypeError('bridge put eof must be boolean');
  if (!body.eof && body.digest != null) throw new TypeError('bridge put digest is only allowed at EOF');
  if (body.eof && (typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(body.digest))) throw new TypeError('bridge put digest is invalid');
  if (offset + data.length > MAX_TRANSFER_BYTES) throw new Error('bridge put exceeds the transfer limit');

  await ensureRoot();
  const metaFile = transferMeta(frame.request);
  const partFile = transferFile(frame.request);
  let meta;
  try { meta = await readJson(metaFile, 'bridge transfer record'); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (offset !== 0) throw new Error('bridge put continuation has no transfer record');
    meta = { protocol: TRANSFER_PROTOCOL, request: frame.request, target: frame.target, destination, state: 'receiving', bytes: 0, digest: null };
    await atomicJson(metaFile, meta);
    await writeFile(partFile, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
  }
  if (meta.protocol !== TRANSFER_PROTOCOL || meta.request !== frame.request || meta.target !== frame.target || JSON.stringify(meta.destination) !== JSON.stringify(destination)) throw new Error('bridge put transfer identity changed');
  if (meta.state === 'completed') {
    if (!body.eof || offset + data.length !== meta.bytes || body.digest !== meta.digest) throw new Error('completed bridge put was replayed with different content');
    const resolved = await resolveLocation(destination, PUT_CLASSES, { requireFile: true });
    const bytes = await readFile(resolved.path);
    if (bytes.length !== meta.bytes || createHash('sha256').update(bytes).digest('hex') !== meta.digest) throw new Error('completed bridge put destination changed');
    return { nextOffset: meta.bytes, complete: true, digest: meta.digest };
  }
  const info = await lstat(partFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TRANSFER_BYTES) throw new Error('bridge put staging object is invalid');
  const size = Number(info.size);
  if (offset > size) throw new Error('bridge put offset skipped staged bytes');
  if (offset < size) {
    if (offset + data.length > size) throw new Error('bridge put replay overlaps unstaged bytes');
    const handle = await open(partFile, 'r');
    try {
      const existing = Buffer.alloc(data.length);
      const { bytesRead } = await handle.read(existing, 0, data.length, offset);
      if (bytesRead !== data.length || !existing.equals(data)) throw new Error('bridge put replay bytes do not match staging');
    } finally { await handle.close(); }
  } else if (data.length > 0) {
    const handle = await open(partFile, 'a');
    try { await handle.write(data); } finally { await handle.close(); }
  }
  const nextOffset = offset + data.length;
  if (!body.eof) return { nextOffset, complete: false, digest: null };

  const staged = await readFile(partFile);
  if (staged.length !== nextOffset || staged.length > MAX_TRANSFER_BYTES) throw new Error('bridge put staging length changed');
  const digest = createHash('sha256').update(staged).digest('hex');
  if (digest !== body.digest) throw new Error('bridge put digest does not match staged bytes');
  const resolved = await resolveLocation(destination, PUT_CLASSES, { createParents: true });
  const parent = await realpath(path.dirname(resolved.path));
  if (!contained(resolved.root, parent)) throw new Error('bridge put destination parent changed');
  try {
    const existing = await lstat(resolved.path);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('bridge put destination is not a regular file');
    await rm(resolved.path, { force: true });
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await rename(partFile, resolved.path);
  const finalInfo = await lstat(resolved.path);
  if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) throw new Error('bridge put destination shape changed');
  meta = { ...meta, state: 'completed', bytes: staged.length, digest, completedAt: new Date().toISOString() };
  await atomicJson(metaFile, meta);
  return { nextOffset: staged.length, complete: true, digest };
}

async function get(frame) {
  const body = requireObject(frame.body, 'bridge get body');
  onlyKeys(body, new Set(['source', 'offset', 'limit']), 'bridge get body');
  const source = normalizeLocation(body.source, 'bridge get source', GET_CLASSES);
  const offset = integer(body.offset, 'bridge get offset', 0, MAX_TRANSFER_BYTES);
  const limit = integer(body.limit, 'bridge get limit', 1, MAX_CHUNK_BYTES);
  const resolved = await resolveLocation(source, GET_CLASSES, { requireFile: true });
  const info = await stat(resolved.path);
  if (!info.isFile() || info.size > MAX_TRANSFER_BYTES) throw new Error('bridge get source exceeds the transfer limit');
  if (offset > info.size) throw new Error('bridge get offset exceeds source length');
  const count = Math.min(limit, Number(info.size) - offset);
  const handle = await open(resolved.path, 'r');
  let data;
  try {
    data = Buffer.alloc(count);
    const { bytesRead } = await handle.read(data, 0, count, offset);
    data = data.subarray(0, bytesRead);
  } finally { await handle.close(); }
  const eof = offset + data.length >= info.size;
  let digest = null;
  if (eof) {
    const complete = await readFile(resolved.path);
    if (complete.length > MAX_TRANSFER_BYTES) throw new Error('bridge get source exceeds the transfer limit');
    digest = createHash('sha256').update(complete).digest('hex');
  }
  return { offset, data: data.toString('base64'), eof, digest };
}

function normalizeFrame(raw) {
  const frame = requireObject(raw, 'bridge request');
  onlyKeys(frame, new Set(['protocol', 'request', 'target', 'kind', 'body']), 'bridge request');
  if (frame.protocol !== PROTOCOL) throw new Error('bridge request protocol is unsupported');
  safeRequest(frame.request);
  safeTarget(frame.target);
  if (typeof frame.kind !== 'string' || !FEATURES.includes(frame.kind)) throw new TypeError('bridge request kind is invalid');
  requireObject(frame.body, 'bridge request body');
  return frame;
}

function response(frame, body) {
  return { protocol: PROTOCOL, request: frame.request, target: frame.target, kind: frame.kind, ok: true, body };
}

function errorResponse(frame, error) {
  const code = error instanceof TypeError ? 'invalid-request' : 'operation-failed';
  const message = String(error?.message ?? 'bridge request failed').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2_048) || 'bridge request failed';
  return { protocol: PROTOCOL, request: frame.request, target: frame.target, kind: frame.kind, ok: false, body: {}, error: { code, message } };
}

async function dispatch(frame) {
  if (frame.kind === 'health') {
    onlyKeys(frame.body, new Set(), 'bridge health body');
    return { version: VERSION, features: [...FEATURES] };
  }
  if (frame.kind === 'execute') return execute(frame);
  if (frame.kind === 'observe') return observe(frame);
  if (frame.kind === 'cancel') return cancel(frame);
  if (frame.kind === 'put') return put(frame);
  if (frame.kind === 'get') return get(frame);
  throw new Error('bridge request kind is unsupported');
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_FRAME_BYTES) throw new Error('bridge request exceeds the hard frame limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function exchangeValue(raw) {
  let parsed = null;
  let frame = null;
  try {
    parsed = JSON.parse(raw);
    frame = normalizeFrame(parsed);
    const body = await dispatch(frame);
    return response(frame, body);
  } catch (error) {
    const candidate = frame ?? (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && parsed.protocol === PROTOCOL && typeof parsed.request === 'string' && REQUEST_ID.test(parsed.request)
      && typeof parsed.target === 'string' && SAFE_TOKEN.test(parsed.target)
      && typeof parsed.kind === 'string' && FEATURES.includes(parsed.kind)
      ? { protocol: PROTOCOL, request: parsed.request, target: parsed.target, kind: parsed.kind } : null);
    if (candidate) return errorResponse(candidate, error);
    throw error;
  }
}

async function exchangeMain() {
  try {
    process.stdout.write(`${JSON.stringify(await exchangeValue(await readStdin()))}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error).slice(0, 2_048)}\n`);
    process.exitCode = 1;
  }
}

async function exchangeLinesMain() {
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_FRAME_BYTES) throw new Error('bridge request exceeds the hard frame limit');
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length === 0) throw new Error('bridge request line is empty');
      process.stdout.write(`${JSON.stringify(await exchangeValue(line.toString('utf8')))}\n`);
    }
    if (pending.length > MAX_FRAME_BYTES) throw new Error('bridge request exceeds the hard frame limit');
  }
  if (pending.length !== 0) throw new Error('bridge request stream ended with an incomplete frame');
}

const mode = process.argv[2];
if (mode === '--run-operation') {
  const request = process.argv[3];
  const token = process.argv[4];
  try {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128 || token.includes('\0')) throw new TypeError('bridge operation monitor token is invalid');
    await runOperation(safeRequest(request), token);
  }
  catch (error) {
    try {
      const record = await loadOperation(request);
      if (record && !['completed', 'failed'].includes(record.state)) {
        record.state = 'failed';
        record.reason = String(error?.message ?? error).slice(0, 2_048);
        record.finishedAt = new Date().toISOString();
        await atomicJson(operationFile(request), record);
      }
      await rm(monitorFile(request), { force: true });
    } catch {}
    process.stderr.write(`${String(error?.message ?? error).slice(0, 2_048)}\n`);
    process.exitCode = 1;
  }
} else if (mode === '--exchange-stdin') {
  await exchangeMain();
} else if (mode === '--exchange-lines') {
  try { await exchangeLinesMain(); }
  catch (error) { process.stderr.write(`${String(error?.message ?? error).slice(0, 2_048)}\n`); process.exitCode = 1; }
} else {
  process.stderr.write('bridge agent requires --exchange-stdin, --exchange-lines, or --run-operation\n');
  process.exitCode = 2;
}
