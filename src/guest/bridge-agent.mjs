import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActivityStore } from './activity-store.mjs';
import { runLocalProcess } from './local-process.mjs';
import { createTransferChannel } from './transfer-channel.mjs';

const PROTOCOL = 'devbridge/environment-bridge-v1';
const VERSION = '1.0.0';
const RECORD_PROTOCOL = 'devbridge/environment-bridge-operation-v2';
const CANCELLATION_PROTOCOL = 'devbridge/environment-bridge-cancellation-v1';
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
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
const MAX_STDIN_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 28_800_000;
const ATOMIC_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const ATOMIC_RENAME_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80, 160]);
const ACTIVITY_OBSERVATION_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80, 160]);
const ACTIVITY_TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
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

function absoluteDirectory(value, name, style, { allowRoot = true } = {}) {
  const candidate = boundedString(value, name, { maxBytes: 4_096 });
  if (!style.isAbsolute(candidate)) throw new TypeError(`${name} must be absolute`);
  const normalized = style.normalize(candidate);
  if (!allowRoot && normalized === style.parse(normalized).root) throw new TypeError(`${name} must not be a filesystem root`);
  return normalized;
}

export function selectStateRoot({ platform = process.platform, homeDirectory, variables = process.env } = {}) {
  const environment = requireObject(variables, 'state variables');
  const style = platform === 'win32' ? path.win32 : path.posix;
  const configured = environment.DEVBRIDGE_GUEST_BRIDGE_ROOT;
  if (configured) return absoluteDirectory(configured, 'configured state root', style, { allowRoot: false });
  if (platform === 'win32') {
    const base = environment.ProgramData || 'C:\\ProgramData';
    return style.join(absoluteDirectory(base, 'state base', style), 'DevBridge', 'bridge');
  }
  const configuredBase = environment.XDG_STATE_HOME;
  const base = configuredBase
    ? absoluteDirectory(configuredBase, 'state base', style)
    : style.join(absoluteDirectory(homeDirectory ?? homedir(), 'home directory', style), '.local', 'state');
  return style.join(base, 'devbridge', 'bridge');
}

const ROOT = selectStateRoot();
const OPERATIONS = path.join(ROOT, '.operations');
const TRANSFERS = path.join(ROOT, '.transfers');
let activityStore = null;
let transferChannel = null;

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

async function localActivity() {
  await ensureRoot();
  if (!activityStore) activityStore = await createActivityStore({ directory: OPERATIONS });
  return activityStore;
}

async function localTransfers() {
  await ensureRoot();
  if (!transferChannel) {
    transferChannel = await createTransferChannel({
      directory: TRANSFERS,
      normalizeWrite: (value) => normalizeLocation(value, 'transfer write location', PUT_CLASSES),
      resolveWrite: async (value, options) => {
        const resolved = await resolveLocation(value, PUT_CLASSES, options);
        return { root: resolved.root, path: resolved.path };
      },
      normalizeRead: (value) => normalizeLocation(value, 'transfer read location', GET_CLASSES),
      resolveRead: async (value, options) => {
        const resolved = await resolveLocation(value, GET_CLASSES, options);
        return { root: resolved.root, path: resolved.path };
      },
    });
  }
  return transferChannel;
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
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        const retry = process.platform === 'win32'
          && ATOMIC_RENAME_RETRY_CODES.has(error?.code)
          && attempt < ATOMIC_RENAME_RETRY_DELAYS_MS.length;
        if (!retry) throw error;
        await new Promise((resolve) => setTimeout(resolve, ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]));
      }
    }
  } catch (error) {
    try { await rm(temporary, { force: true }); } catch {}
    throw error;
  }
}

async function readJson(file, name) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error(`${name} is invalid`);
  return JSON.parse(await readFile(file, 'utf8'));
}

function operationFile(request) { return path.join(OPERATIONS, `${safeRequest(request)}.json`); }
function cancelFile(request) { return path.join(OPERATIONS, `${safeRequest(request)}.cancel.json`); }

async function loadOperation(request) {
  await ensureRoot();
  try { return await readJson(operationFile(request), 'bridge operation record'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function validateOperationRecord(record, request, target, body = null) {
  const value = requireObject(record, 'bridge operation record');
  onlyKeys(value, new Set([
    'protocol', 'request', 'target', 'digest', 'body', 'state', 'createdAt', 'activityToken',
    'result', 'reason', 'attemptedAt', 'startedAt', 'finishedAt',
  ]), 'bridge operation record');
  if (value.protocol !== RECORD_PROTOCOL || value.request !== request || value.target !== target || !['planned', 'attempting', 'running', 'completed', 'failed'].includes(value.state)) throw new Error('bridge operation record identity is invalid');
  if (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest)) throw new Error('bridge operation record digest is invalid');
  boundedString(value.createdAt, 'bridge operation creation time', { maxBytes: 64 });
  if (value.state === 'planned') {
    if (value.activityToken !== null) throw new Error('planned bridge operation activity identity is invalid');
  } else if (typeof value.activityToken !== 'string' || !ACTIVITY_TOKEN.test(value.activityToken)) {
    throw new Error('bridge operation activity identity is invalid');
  }
  if (value.state === 'completed' && (!value.result || typeof value.result !== 'object' || Array.isArray(value.result))) throw new Error('completed bridge operation result is invalid');
  if (value.state === 'failed') boundedString(value.reason ?? '', 'bridge operation failure', { maxBytes: 2_048 });
  if (body && value.digest !== digestObject(body)) throw new Error('bridge request identity was reused for a different operation');
  return value;
}

async function resultState(record) {
  if (record.state === 'completed') return { state: 'completed', result: record.result, reason: null };
  if (record.state === 'failed') return { state: 'failed', result: null, reason: boundedString(record.reason ?? 'bridge operation failed', 'bridge operation failure', { maxBytes: 2_048 }) };
  const activity = await localActivity();
  if (record.state === 'planned') {
    if (await activity.attempted(record.request)) return { state: 'indeterminate', result: null, reason: 'bridge operation attempt identity is incomplete' };
    return { state: 'planned', result: null, reason: null };
  }
  const observation = await activity.inspect(record.request, record.activityToken);
  if (observation === 'current') return { state: 'running', result: null, reason: null };
  return { state: 'indeterminate', result: null, reason: 'bridge operation activity is no longer current' };
}

async function observedState(request, target, record) {
  let observed = await resultState(record);
  if (observed.state !== 'indeterminate') return observed;
  for (const delay of ACTIVITY_OBSERVATION_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const refreshed = await loadOperation(request);
    if (!refreshed) return observed;
    validateOperationRecord(refreshed, request, target);
    observed = await resultState(refreshed);
    if (observed.state !== 'indeterminate') return observed;
  }
  return observed;
}

async function cancellationReason(request) {
  try {
    const value = await readJson(cancelFile(request), 'bridge cancellation record');
    requireObject(value, 'bridge cancellation record');
    onlyKeys(value, new Set(['protocol', 'request', 'reason']), 'bridge cancellation record');
    if (value.protocol !== CANCELLATION_PROTOCOL || value.request !== request || !['timeout', 'abort'].includes(value.reason)) throw new Error('bridge cancellation record identity is invalid');
    return value.reason;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function publishCancellation(request, reason) {
  await atomicJson(cancelFile(request), { protocol: CANCELLATION_PROTOCOL, request, reason });
}

async function runOperation(request, token) {
  const activity = await localActivity();
  if (!await activity.claim(request, token)) return;
  const record = await loadOperation(request);
  if (!record) throw new Error('bridge operation record is absent');
  validateOperationRecord(record, request, record.target);
  if (record.state !== 'planned') return;
  const body = normalizeOperation(record.body);
  await activity.publish(request, token);
  record.state = 'attempting';
  record.activityToken = token;
  record.attemptedAt = new Date().toISOString();
  await atomicJson(operationFile(request), record);
  let terminalRecorded = false;
  try {
    const working = await resolveLocation(body.directory, EXECUTION_CLASSES, { allowRoot: true, createParents: true });
    const argumentsList = [];
    for (const argument of body.arguments) {
      if (typeof argument === 'string') { argumentsList.push(argument); continue; }
      const createParents = argument.class !== 'input';
      const resolved = await resolveLocation(argument, ARGUMENT_CLASSES, { createParents, requireFile: argument.class === 'input' });
      argumentsList.push(resolved.path);
    }
    const result = await runLocalProcess({
      program: body.program,
      arguments: argumentsList,
      directory: working.path,
      environment: body.environment,
      input: body.input,
      timeoutMs: body.timeoutMs,
      maxOutputBytes: body.maxOutputBytes,
    }, {
      pulse: () => activity.publish(request, token),
      readStop: () => cancellationReason(request),
      writeStop: (reason) => publishCancellation(request, reason),
    });
    record.state = 'completed';
    record.finishedAt = result.finishedAt;
    record.result = result;
    await atomicJson(operationFile(request), record);
    terminalRecorded = true;
  } catch (error) {
    record.state = 'failed';
    record.reason = String(error?.message ?? 'bridge operation failed').slice(0, 2_048);
    record.finishedAt = new Date().toISOString();
    await atomicJson(operationFile(request), record);
    terminalRecorded = true;
  } finally {
    if (terminalRecorded) await rm(cancelFile(request), { force: true });
    await activity.remove(request, token);
  }
}

async function execute(frame) {
  const body = normalizeOperation(frame.body);
  let record = await loadOperation(frame.request);
  if (record) {
    validateOperationRecord(record, frame.request, frame.target, body);
    if (record.state === 'planned') return startAttempt(frame.request, record);
    return resultState(record);
  }
  record = {
    protocol: RECORD_PROTOCOL,
    request: frame.request,
    target: frame.target,
    digest: digestObject(body),
    body,
    state: 'planned',
    createdAt: new Date().toISOString(),
    activityToken: null,
    result: null,
    reason: null,
  };
  await atomicJson(operationFile(frame.request), record);
  return startAttempt(frame.request, record);
}

async function startAttempt(request, record) {
  const current = await resultState(record);
  if (current.state !== 'planned') return current;
  const token = randomUUID();
  try {
    const monitor = spawn(process.execPath, [SELF, '--run-operation', request, token], {
      stdio: 'ignore', shell: false, windowsHide: true, detached: true, env: process.env,
    });
    await new Promise((resolve, reject) => {
      monitor.once('spawn', resolve);
      monitor.once('error', reject);
    });
    monitor.unref();
  } catch (error) {
    throw new Error(String(error?.message ?? 'bridge operation activity could not start').slice(0, 2_048));
  }
  return observedState(request, record.target, record);
}

async function observe(frame) {
  onlyKeys(requireObject(frame.body, 'bridge observe body'), new Set(), 'bridge observe body');
  const record = await loadOperation(frame.request);
  if (!record) return { state: 'absent', result: null, reason: null };
  validateOperationRecord(record, frame.request, frame.target);
  return observedState(frame.request, frame.target, record);
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
  await publishCancellation(frame.request, body.reason);
  const current = await observedState(frame.request, frame.target, record);
  if (current.state === 'completed') return { state: 'completed' };
  if (current.state === 'indeterminate') return { state: 'indeterminate' };
  return { state: 'running' };
}

async function put(frame) {
  return (await localTransfers()).put({ identity: frame.request, binding: frame.target, value: frame.body });
}

async function get(frame) {
  return (await localTransfers()).get({ identity: frame.request, binding: frame.target, value: frame.body });
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

async function exchangeMain() {
  let parsed = null;
  let frame = null;
  try {
    const raw = await readStdin();
    parsed = JSON.parse(raw);
    frame = normalizeFrame(parsed);
    const body = await dispatch(frame);
    process.stdout.write(`${JSON.stringify(response(frame, body))}\n`);
  } catch (error) {
    const candidate = frame ?? (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && parsed.protocol === PROTOCOL && typeof parsed.request === 'string' && REQUEST_ID.test(parsed.request)
      && typeof parsed.target === 'string' && SAFE_TOKEN.test(parsed.target)
      && typeof parsed.kind === 'string' && FEATURES.includes(parsed.kind)
      ? { protocol: PROTOCOL, request: parsed.request, target: parsed.target, kind: parsed.kind } : null);
    if (candidate) {
      process.stdout.write(`${JSON.stringify(errorResponse(candidate, error))}\n`);
      return;
    }
    process.stderr.write(`${String(error?.message ?? error).slice(0, 2_048)}\n`);
    process.exitCode = 1;
  }
}

async function commandMain(argv = process.argv) {
  const mode = argv[2];
  if (mode === '--run-operation') {
    const request = argv[3];
    const token = argv[4];
    try {
      if (typeof token !== 'string' || !ACTIVITY_TOKEN.test(token)) throw new TypeError('bridge operation activity token is invalid');
      await runOperation(safeRequest(request), token);
    }
    catch (error) { process.stderr.write(`${String(error?.message ?? error).slice(0, 2_048)}\n`); process.exitCode = 1; }
  } else if (mode === '--exchange-stdin') {
    await exchangeMain();
  } else {
    process.stderr.write('bridge agent requires --exchange-stdin or --run-operation\n');
    process.exitCode = 2;
  }
}

if (typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === path.resolve(SELF)) await commandMain();
