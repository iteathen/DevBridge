import { createHash, randomBytes } from 'node:crypto';

export const ENVIRONMENT_BRIDGE_PROTOCOL = 'devbridge/environment-bridge-v1';
export const ENVIRONMENT_BRIDGE_VERSION = '1.0.0';

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const REQUEST_ID = /^[a-f0-9]{32}$/u;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/u;
const REQUEST_KINDS = new Set(['health', 'execute', 'observe', 'cancel', 'put', 'get']);
const REQUIRED_FEATURES = Object.freeze(['health', 'execute', 'observe', 'cancel', 'put', 'get']);
const EXECUTION_CLASSES = new Set(['work', 'scratch', 'cache']);
const ARGUMENT_CLASSES = new Set(['input', 'work', 'output', 'scratch', 'cache']);
const PUT_CLASSES = new Set(['input', 'work', 'scratch', 'cache']);
const GET_CLASSES = new Set(['output', 'work', 'scratch', 'cache']);
const MAX_ARGUMENTS = 256;
const MAX_ENVIRONMENT = 128;
const MAX_STDIN_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 28_800_000;
const MAX_ERROR_BYTES = 2_048;
const MAX_REQUEST_FRAME_BYTES = 44 * 1024;
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const POLL_MS = 2_000;
const CANCEL_RECONCILE_MS = 5_000;

export class EnvironmentBridgeError extends Error {
  constructor(message, { code = 'bridge-error', request = null, target = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EnvironmentBridgeError';
    this.code = code;
    this.request = request;
    this.target = target;
  }
}

export class EnvironmentBridgeIndeterminateError extends EnvironmentBridgeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'indeterminate' });
    this.name = 'EnvironmentBridgeIndeterminateError';
  }
}

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

function targetToken(value) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) throw new TypeError('bridge target must be an opaque local token');
  return value;
}

function requestToken(value = null) {
  if (value == null) return randomBytes(16).toString('hex');
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new TypeError('bridge request identity is invalid');
  return value;
}

function relativePath(value, name, { allowRoot = false } = {}) {
  const text = boundedString(value ?? (allowRoot ? '.' : ''), name, { allowEmpty: false, maxBytes: 4_096 }).replace(/\\/gu, '/');
  if (text.startsWith('/') || text.startsWith('//') || /^[A-Za-z]:/u.test(text) || text.includes(':')) throw new TypeError(`${name} must be portable and relative`);
  const segments = text.split('/');
  if (segments.some((segment) => segment === '..' || segment.length === 0)) throw new TypeError(`${name} contains an invalid segment`);
  if (!allowRoot && segments.every((segment) => segment === '.')) throw new TypeError(`${name} must identify a non-root item`);
  return segments.filter((segment) => segment !== '.').join('/') || '.';
}

function location(raw, name, classes, { allowRoot = false } = {}) {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['class', 'path']), name);
  if (typeof value.class !== 'string' || !classes.has(value.class)) throw new TypeError(`${name}.class is invalid`);
  return { class: value.class, path: relativePath(value.path ?? (allowRoot ? '.' : ''), `${name}.path`, { allowRoot }) };
}

function normalizeOperation(raw) {
  const value = requireObject(raw, 'bridge operation');
  onlyKeys(value, new Set(['program', 'arguments', 'directory', 'environment', 'input', 'timeoutMs', 'maxOutputBytes']), 'bridge operation');
  if (typeof value.program !== 'string' || !SAFE_NAME.test(value.program) || value.program.includes('/') || value.program.includes('\\')) {
    throw new TypeError('bridge operation.program must be a logical executable identity');
  }
  const args = value.arguments ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) throw new TypeError(`bridge operation.arguments must contain at most ${MAX_ARGUMENTS} entries`);
  const argumentsList = args.map((entry, index) => {
    if (typeof entry === 'string') return boundedString(entry, `bridge operation.arguments[${index}]`, { allowEmpty: true, maxBytes: 65_536 });
    return location(entry, `bridge operation.arguments[${index}]`, ARGUMENT_CLASSES);
  });
  const rawEnvironment = requireObject(value.environment ?? {}, 'bridge operation.environment');
  if (Object.keys(rawEnvironment).length > MAX_ENVIRONMENT) throw new TypeError('bridge operation.environment is too large');
  const environment = {};
  for (const [key, entry] of Object.entries(rawEnvironment)) {
    if (!ENV_NAME.test(key)) throw new TypeError(`bridge operation.environment.${key} name is invalid`);
    environment[key] = boundedString(entry, `bridge operation.environment.${key}`, { allowEmpty: true, maxBytes: 16_384 });
  }
  const input = value.input == null ? null : boundedString(value.input, 'bridge operation.input', { allowEmpty: true, maxBytes: MAX_STDIN_BYTES });
  return {
    program: value.program,
    arguments: argumentsList,
    directory: location(value.directory ?? { class: 'work', path: '.' }, 'bridge operation.directory', EXECUTION_CLASSES, { allowRoot: true }),
    environment,
    input,
    timeoutMs: integer(value.timeoutMs ?? 120_000, 'bridge operation.timeoutMs', 1_000, MAX_TIMEOUT_MS),
    maxOutputBytes: integer(value.maxOutputBytes ?? 512 * 1024, 'bridge operation.maxOutputBytes', 1_024, MAX_OUTPUT_BYTES),
  };
}

function canonicalBase64(value, name, maxBytes) {
  const text = boundedString(value, name, { allowEmpty: true, maxBytes: Math.ceil(maxBytes * 4 / 3) + 16 });
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== text) throw new EnvironmentBridgeError(`${name} is not canonical bounded base64`, { code: 'protocol' });
  return bytes;
}

function normalizeResult(raw, maxOutputBytes = MAX_OUTPUT_BYTES) {
  const value = requireObject(raw, 'bridge result');
  onlyKeys(value, new Set(['exitCode', 'signal', 'timedOut', 'aborted', 'outputTruncated', 'stdout', 'stderr', 'startedAt', 'finishedAt', 'lastOutputAt']), 'bridge result');
  if (value.exitCode != null && (!Number.isInteger(value.exitCode) || value.exitCode < -1 || value.exitCode > 255)) throw new EnvironmentBridgeError('bridge result.exitCode is invalid', { code: 'protocol' });
  for (const name of ['timedOut', 'aborted', 'outputTruncated']) if (typeof value[name] !== 'boolean') throw new EnvironmentBridgeError(`bridge result.${name} must be boolean`, { code: 'protocol' });
  const stdout = canonicalBase64(value.stdout ?? '', 'bridge result.stdout', maxOutputBytes);
  const stderr = canonicalBase64(value.stderr ?? '', 'bridge result.stderr', maxOutputBytes);
  if (stdout.length + stderr.length > maxOutputBytes) throw new EnvironmentBridgeError('bridge result output exceeds the requested aggregate limit', { code: 'protocol' });
  const timestamp = (entry, name) => entry == null ? null : boundedString(entry, name, { allowEmpty: false, maxBytes: 128 });
  const signal = value.signal == null ? null : boundedString(value.signal, 'bridge result.signal', { allowEmpty: false, maxBytes: 128 });
  return {
    exitCode: value.exitCode ?? null,
    signal,
    timedOut: value.timedOut,
    aborted: value.aborted,
    outputTruncated: value.outputTruncated,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    startedAt: timestamp(value.startedAt, 'bridge result.startedAt'),
    finishedAt: timestamp(value.finishedAt, 'bridge result.finishedAt'),
    lastOutputAt: timestamp(value.lastOutputAt, 'bridge result.lastOutputAt'),
  };
}

function frameSize(value) {
  let text;
  try { text = JSON.stringify(value); } catch (error) { throw new EnvironmentBridgeError('bridge response is not serializable', { code: 'protocol', cause: error }); }
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_FRAME_BYTES) throw new EnvironmentBridgeError('bridge response exceeds the hard frame limit', { code: 'protocol' });
  return size;
}

function emptyBody(raw, name) {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(), name);
  return {};
}

function digest(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${name} must be a sha256 digest`);
  return value;
}

function normalizeRequestBody(kind, raw) {
  if (kind === 'health' || kind === 'observe') return emptyBody(raw, `bridge ${kind} request`);
  if (kind === 'execute') return normalizeOperation(raw);
  if (kind === 'cancel') {
    const value = requireObject(raw, 'bridge cancel request');
    onlyKeys(value, new Set(['reason']), 'bridge cancel request');
    if (!['abort', 'timeout'].includes(value.reason)) throw new TypeError('bridge cancel request.reason is invalid');
    return { reason: value.reason };
  }
  if (kind === 'put') {
    const value = requireObject(raw, 'bridge put request');
    onlyKeys(value, new Set(['destination', 'offset', 'data', 'eof', 'digest']), 'bridge put request');
    const destination = location(value.destination, 'bridge put request.destination', PUT_CLASSES);
    const offset = integer(value.offset, 'bridge put request.offset', 0, MAX_TRANSFER_BYTES);
    const data = canonicalBase64(value.data ?? '', 'bridge put request.data', CHUNK_BYTES);
    if (typeof value.eof !== 'boolean') throw new TypeError('bridge put request.eof must be boolean');
    if (!value.eof && data.length === 0) throw new TypeError('bridge put request made no progress');
    if (offset + data.length > MAX_TRANSFER_BYTES) throw new TypeError('bridge put request exceeds the transfer limit');
    const selectedDigest = digest(value.digest, 'bridge put request.digest', { nullable: !value.eof });
    if (!value.eof && selectedDigest != null) throw new TypeError('bridge put request cannot expose a digest before EOF');
    return { destination, offset, data: data.toString('base64'), eof: value.eof, digest: selectedDigest };
  }
  if (kind === 'get') {
    const value = requireObject(raw, 'bridge get request');
    onlyKeys(value, new Set(['source', 'offset', 'limit']), 'bridge get request');
    const source = location(value.source, 'bridge get request.source', GET_CLASSES);
    const offset = integer(value.offset, 'bridge get request.offset', 0, MAX_TRANSFER_BYTES - 1);
    const limit = integer(value.limit, 'bridge get request.limit', 1, CHUNK_BYTES);
    if (offset + limit > MAX_TRANSFER_BYTES) throw new TypeError('bridge get request exceeds the transfer limit');
    return { source, offset, limit };
  }
  throw new TypeError('bridge request kind is invalid');
}

export function normalizeEnvironmentBridgeRequest(raw) {
  const value = requireObject(raw, 'bridge request');
  onlyKeys(value, new Set(['protocol', 'request', 'target', 'kind', 'body']), 'bridge request');
  if (value.protocol !== ENVIRONMENT_BRIDGE_PROTOCOL) throw new TypeError('bridge request protocol is unsupported');
  const request = requestToken(value.request);
  const target = targetToken(value.target);
  if (typeof value.kind !== 'string' || !REQUEST_KINDS.has(value.kind)) throw new TypeError('bridge request kind is invalid');
  const result = {
    protocol: ENVIRONMENT_BRIDGE_PROTOCOL,
    request,
    target,
    kind: value.kind,
    body: normalizeRequestBody(value.kind, value.body),
  };
  if (frameSize(result) > MAX_REQUEST_FRAME_BYTES) throw new EnvironmentBridgeError('bridge request exceeds the common transport frame limit', { code: 'limit', request, target });
  return result;
}

function encodedResult(raw, maxOutputBytes = MAX_OUTPUT_BYTES) {
  const value = requireObject(raw, 'bridge result');
  onlyKeys(value, new Set(['exitCode', 'signal', 'timedOut', 'aborted', 'outputTruncated', 'stdout', 'stderr', 'startedAt', 'finishedAt', 'lastOutputAt']), 'bridge result');
  if (value.exitCode != null && (!Number.isInteger(value.exitCode) || value.exitCode < -1 || value.exitCode > 255)) throw new EnvironmentBridgeError('bridge result.exitCode is invalid', { code: 'protocol' });
  for (const name of ['timedOut', 'aborted', 'outputTruncated']) if (typeof value[name] !== 'boolean') throw new EnvironmentBridgeError(`bridge result.${name} must be boolean`, { code: 'protocol' });
  const stdout = canonicalBase64(value.stdout ?? '', 'bridge result.stdout', maxOutputBytes);
  const stderr = canonicalBase64(value.stderr ?? '', 'bridge result.stderr', maxOutputBytes);
  if (stdout.length + stderr.length > maxOutputBytes) throw new EnvironmentBridgeError('bridge result output exceeds the requested aggregate limit', { code: 'protocol' });
  const timestamp = (entry, name) => entry == null ? null : boundedString(entry, name, { allowEmpty: false, maxBytes: 128 });
  const signal = value.signal == null ? null : boundedString(value.signal, 'bridge result.signal', { allowEmpty: false, maxBytes: 128 });
  return {
    exitCode: value.exitCode ?? null,
    signal,
    timedOut: value.timedOut,
    aborted: value.aborted,
    outputTruncated: value.outputTruncated,
    stdout: stdout.toString('base64'),
    stderr: stderr.toString('base64'),
    startedAt: timestamp(value.startedAt, 'bridge result.startedAt'),
    finishedAt: timestamp(value.finishedAt, 'bridge result.finishedAt'),
    lastOutputAt: timestamp(value.lastOutputAt, 'bridge result.lastOutputAt'),
  };
}

function encodedExecutionState(raw, maxOutputBytes) {
  const value = requireObject(raw, 'bridge execution state');
  onlyKeys(value, new Set(['state', 'result', 'reason']), 'bridge execution state');
  if (!['absent', 'planned', 'running', 'completed', 'failed', 'indeterminate'].includes(value.state)) throw new EnvironmentBridgeError('bridge execution state is invalid', { code: 'protocol' });
  const reason = value.reason == null ? null : boundedString(value.reason, 'bridge execution state.reason', { maxBytes: MAX_ERROR_BYTES });
  if (value.state === 'completed') {
    if (value.result == null) throw new EnvironmentBridgeError('completed bridge execution has no result', { code: 'protocol' });
    return { state: value.state, result: encodedResult(value.result, maxOutputBytes), reason };
  }
  if (value.result != null) throw new EnvironmentBridgeError('non-completed bridge execution must not include a result', { code: 'protocol' });
  return { state: value.state, result: null, reason };
}

function normalizeSuccessfulResponseBody(raw, expected) {
  if (expected.kind === 'health') {
    const value = requireObject(raw, 'bridge health response');
    onlyKeys(value, new Set(['version', 'features']), 'bridge health response');
    const version = boundedString(value.version, 'bridge health response.version', { maxBytes: 128 });
    if (!VERSION.test(version)) throw new TypeError('bridge health response.version is invalid');
    if (!Array.isArray(value.features) || value.features.length > 32 || value.features.some((entry) => typeof entry !== 'string' || !SAFE_NAME.test(entry))) {
      throw new TypeError('bridge health response.features are invalid');
    }
    return { version, features: [...new Set(value.features)].sort() };
  }
  if (expected.kind === 'execute' || expected.kind === 'observe') {
    const limit = expected.kind === 'execute' ? expected.body.maxOutputBytes : MAX_OUTPUT_BYTES;
    return encodedExecutionState(raw, limit);
  }
  if (expected.kind === 'cancel') {
    const value = requireObject(raw, 'bridge cancel response');
    onlyKeys(value, new Set(['state']), 'bridge cancel response');
    if (!['absent', 'running', 'completed', 'indeterminate'].includes(value.state)) throw new TypeError('bridge cancel response.state is invalid');
    return { state: value.state };
  }
  if (expected.kind === 'put') {
    const value = requireObject(raw, 'bridge put response');
    onlyKeys(value, new Set(['nextOffset', 'complete', 'digest']), 'bridge put response');
    const bytes = canonicalBase64(expected.body.data, 'bridge put request.data', CHUNK_BYTES);
    const nextOffset = expected.body.offset + bytes.length;
    if (!Number.isSafeInteger(value.nextOffset) || value.nextOffset !== nextOffset || typeof value.complete !== 'boolean') {
      throw new TypeError('bridge put response offset is inconsistent');
    }
    const selectedDigest = digest(value.digest, 'bridge put response.digest', { nullable: !expected.body.eof });
    if (expected.body.eof) {
      if (!value.complete || selectedDigest !== expected.body.digest) throw new TypeError('bridge put response completion is inconsistent');
    } else if (value.complete || selectedDigest != null) throw new TypeError('bridge put response completed before source EOF');
    return { nextOffset, complete: value.complete, digest: selectedDigest };
  }
  if (expected.kind === 'get') {
    const value = requireObject(raw, 'bridge get response');
    onlyKeys(value, new Set(['offset', 'data', 'eof', 'digest']), 'bridge get response');
    if (value.offset !== expected.body.offset || typeof value.eof !== 'boolean') throw new TypeError('bridge get response offset is inconsistent');
    const data = canonicalBase64(value.data ?? '', 'bridge get response.data', expected.body.limit);
    if (!value.eof && data.length === 0) throw new TypeError('bridge get response made no progress');
    const selectedDigest = digest(value.digest, 'bridge get response.digest', { nullable: !value.eof });
    if (!value.eof && selectedDigest != null) throw new TypeError('bridge get response exposed a digest before EOF');
    return { offset: value.offset, data: data.toString('base64'), eof: value.eof, digest: selectedDigest };
  }
  throw new TypeError('bridge response kind is invalid');
}

export function normalizeEnvironmentBridgeResponse(raw, expectedRaw) {
  const expected = normalizeEnvironmentBridgeRequest(expectedRaw);
  frameSize(raw);
  const value = requireObject(raw, 'bridge response');
  onlyKeys(value, new Set(['protocol', 'request', 'target', 'kind', 'ok', 'body', 'error']), 'bridge response');
  if (value.protocol !== ENVIRONMENT_BRIDGE_PROTOCOL || value.request !== expected.request || value.target !== expected.target || value.kind !== expected.kind) {
    throw new EnvironmentBridgeError('bridge response identity does not match the request', { code: 'protocol', request: expected.request, target: expected.target });
  }
  if (typeof value.ok !== 'boolean') throw new EnvironmentBridgeError('bridge response.ok must be boolean', { code: 'protocol', request: expected.request, target: expected.target });
  if (!value.ok) {
    const error = requireObject(value.error, 'bridge response.error');
    onlyKeys(error, new Set(['code', 'message']), 'bridge response.error');
    const code = typeof error.code === 'string' && SAFE_NAME.test(error.code) ? error.code : 'remote-error';
    const message = boundedString(error.message ?? 'bridge request failed', 'bridge response.error.message', { maxBytes: MAX_ERROR_BYTES });
    return { protocol: ENVIRONMENT_BRIDGE_PROTOCOL, request: expected.request, target: expected.target, kind: expected.kind, ok: false, error: { code, message } };
  }
  if (value.error != null) throw new EnvironmentBridgeError('successful bridge response must not include error', { code: 'protocol', request: expected.request, target: expected.target });
  const body = normalizeSuccessfulResponseBody(value.body, expected);
  const result = { protocol: ENVIRONMENT_BRIDGE_PROTOCOL, request: expected.request, target: expected.target, kind: expected.kind, ok: true, body };
  frameSize(result);
  return result;
}

function prefixedLocation(raw, prefix) {
  const selected = requireObject(raw, 'bridge location');
  const nextPath = selected.path === '.' ? prefix : `${prefix}/${selected.path}`;
  return { class: selected.class, path: nextPath };
}

export function rebindEnvironmentBridgeRequest(raw, { target: rawTarget, prefix: rawPrefix } = {}) {
  const value = normalizeEnvironmentBridgeRequest(raw);
  const target = targetToken(rawTarget);
  const prefix = relativePath(rawPrefix, 'bridge request prefix');
  let body = structuredClone(value.body);
  if (value.kind === 'execute') {
    body.directory = prefixedLocation(body.directory, prefix);
    body.arguments = body.arguments.map((entry) => typeof entry === 'string' ? entry : prefixedLocation(entry, prefix));
  } else if (value.kind === 'put') body.destination = prefixedLocation(body.destination, prefix);
  else if (value.kind === 'get') body.source = prefixedLocation(body.source, prefix);
  return normalizeEnvironmentBridgeRequest({ ...value, target, body });
}

export function rebindEnvironmentBridgeResponse(raw, { from: rawFrom, to: rawTo } = {}) {
  const from = normalizeEnvironmentBridgeRequest(rawFrom);
  const to = normalizeEnvironmentBridgeRequest(rawTo);
  if (from.request !== to.request || from.kind !== to.kind) throw new TypeError('bridge response rebinding request identity is inconsistent');
  const response = normalizeEnvironmentBridgeResponse(raw, from);
  return normalizeEnvironmentBridgeResponse({ ...response, target: to.target }, to);
}

function responseFrame(raw, expected) {
  const value = normalizeEnvironmentBridgeResponse(raw, expected);
  if (!value.ok) throw new EnvironmentBridgeError(value.error.message, { code: value.error.code, request: expected.request, target: expected.target });
  return value.body;
}

function executionState(raw, maxOutputBytes) {
  const value = requireObject(raw, 'bridge execution state');
  onlyKeys(value, new Set(['state', 'result', 'reason']), 'bridge execution state');
  if (!['absent', 'planned', 'running', 'completed', 'failed', 'indeterminate'].includes(value.state)) throw new EnvironmentBridgeError('bridge execution state is invalid', { code: 'protocol' });
  const reason = value.reason == null ? null : boundedString(value.reason, 'bridge execution state.reason', { maxBytes: MAX_ERROR_BYTES });
  if (value.state === 'completed') {
    if (value.result == null) throw new EnvironmentBridgeError('completed bridge execution has no result', { code: 'protocol' });
    return { state: value.state, result: normalizeResult(value.result, maxOutputBytes), reason };
  }
  if (value.result != null) throw new EnvironmentBridgeError('non-completed bridge execution must not include a result', { code: 'protocol' });
  return { state: value.state, result: null, reason };
}

function wait(ms, signal = null) {
  if (signal?.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    const timer = setTimeout(() => done('elapsed'), ms);
    const onAbort = () => done('aborted');
    const done = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function bytesFromPort(raw, name) {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['data', 'eof']), name);
  if (typeof value.eof !== 'boolean') throw new TypeError(`${name}.eof must be boolean`);
  const data = Buffer.isBuffer(value.data) ? value.data : value.data instanceof Uint8Array ? Buffer.from(value.data) : typeof value.data === 'string' ? Buffer.from(value.data, 'utf8') : null;
  if (!data) throw new TypeError(`${name}.data must be bytes or text`);
  if (data.length > CHUNK_BYTES) throw new TypeError(`${name}.data exceeds the bridge chunk limit`);
  if (!value.eof && data.length === 0) throw new TypeError(`${name} made no progress`);
  return { data, eof: value.eof };
}

export class EnvironmentBridge {
  #exchange;

  constructor({ exchange }) {
    if (typeof exchange !== 'function') throw new TypeError('bridge exchange must be a function');
    this.#exchange = exchange;
  }

  async #send(target, request, kind, body, { signal = null } = {}) {
    const frame = { protocol: ENVIRONMENT_BRIDGE_PROTOCOL, request, target, kind, body };
    if (frameSize(frame) > MAX_REQUEST_FRAME_BYTES) throw new EnvironmentBridgeError('bridge request exceeds the common transport frame limit', { code: 'limit', request, target });
    let raw;
    try { raw = await this.#exchange(frame, { signal }); }
    catch (error) {
      if (error instanceof EnvironmentBridgeError) throw error;
      throw new EnvironmentBridgeError('bridge exchange failed', { code: 'exchange', request, target, cause: error });
    }
    return responseFrame(raw, frame);
  }

  async health(rawTarget) {
    const target = targetToken(rawTarget);
    const request = requestToken();
    const body = await this.#send(target, request, 'health', {});
    onlyKeys(body, new Set(['version', 'features']), 'bridge health');
    const version = boundedString(body.version, 'bridge health.version', { maxBytes: 128 });
    const match = VERSION.exec(version);
    if (!match) throw new EnvironmentBridgeError('bridge health version is invalid', { code: 'protocol', request, target });
    if (!Array.isArray(body.features) || body.features.length > 32 || body.features.some((entry) => typeof entry !== 'string' || !SAFE_NAME.test(entry))) {
      throw new EnvironmentBridgeError('bridge health features are invalid', { code: 'protocol', request, target });
    }
    const features = [...new Set(body.features)].sort();
    const compatible = Number(match[1]) === 1 && REQUIRED_FEATURES.every((feature) => features.includes(feature));
    return Object.freeze({ ready: compatible, version, features, reason: compatible ? null : 'bridge protocol features are incompatible' });
  }

  async observe(rawTarget, rawRequest, { maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
    const target = targetToken(rawTarget);
    const request = requestToken(rawRequest);
    const limit = integer(maxOutputBytes, 'bridge observe maxOutputBytes', 1_024, MAX_OUTPUT_BYTES);
    const body = await this.#send(target, request, 'observe', {});
    return executionState(body, limit);
  }

  async cancel(rawTarget, rawRequest, { reason = 'abort' } = {}) {
    const target = targetToken(rawTarget);
    const request = requestToken(rawRequest);
    if (!['abort', 'timeout'].includes(reason)) throw new TypeError('bridge cancellation reason is invalid');
    const body = await this.#send(target, request, 'cancel', { reason });
    onlyKeys(body, new Set(['state']), 'bridge cancellation');
    if (!['absent', 'running', 'completed', 'indeterminate'].includes(body.state)) throw new EnvironmentBridgeError('bridge cancellation state is invalid', { code: 'protocol', request, target });
    return { state: body.state };
  }

  async #recoverExecute(target, request, operation, signal) {
    try {
      const state = await this.observe(target, request, { maxOutputBytes: operation.maxOutputBytes });
      if (state.state !== 'absent') return state;
    } catch {
      throw new EnvironmentBridgeIndeterminateError('bridge execution could not be reconciled after an interrupted start', { request, target });
    }
    try {
      const body = await this.#send(target, request, 'execute', operation, { signal });
      return executionState(body, operation.maxOutputBytes);
    } catch (error) {
      throw new EnvironmentBridgeIndeterminateError('bridge execution start remained ambiguous after observe-before-repeat', { request, target, cause: error });
    }
  }

  async #settleCancellation(target, request, operation, flags) {
    const deadline = Date.now() + CANCEL_RECONCILE_MS;
    while (Date.now() < deadline) {
      try {
        const state = await this.observe(target, request, { maxOutputBytes: operation.maxOutputBytes });
        if (state.state === 'completed') return { completion: 'observed', request, target, result: state.result };
        if (state.state === 'failed') throw new EnvironmentBridgeError(state.reason ?? 'bridge execution failed while reconciling cancellation', { code: 'remote-error', request, target });
        if (state.state === 'absent' || state.state === 'indeterminate') break;
      } catch (error) {
        if (error instanceof EnvironmentBridgeError && error.code !== 'indeterminate') break;
      }
      await wait(250);
    }
    return { completion: 'indeterminate', request, target, timedOut: flags.timedOut, aborted: flags.aborted, reason: 'bridge execution completion could not be observed after cancellation' };
  }

  async execute(rawTarget, rawOperation, { request: rawRequest = null, signal = null, onActivity = null, pollIntervalMs = POLL_MS } = {}) {
    const target = targetToken(rawTarget);
    const request = requestToken(rawRequest);
    const operation = normalizeOperation(rawOperation);
    if (signal != null && typeof signal !== 'object') throw new TypeError('bridge execution signal is invalid');
    if (onActivity != null && typeof onActivity !== 'function') throw new TypeError('bridge execution onActivity is invalid');
    integer(pollIntervalMs, 'bridge execution pollIntervalMs', 100, 30_000);
    if (signal?.aborted) {
      return {
        completion: 'observed',
        request,
        target,
        result: {
          exitCode: null,
          signal: null,
          timedOut: false,
          aborted: true,
          outputTruncated: false,
          stdout: '',
          stderr: '',
          startedAt: null,
          finishedAt: null,
          lastOutputAt: null,
        },
      };
    }

    let state;
    try {
      const body = await this.#send(target, request, 'execute', operation, { signal });
      state = executionState(body, operation.maxOutputBytes);
    } catch (error) {
      if (error instanceof EnvironmentBridgeError && (error.code === 'limit' || error.code === 'protocol')) throw error;
      if (signal?.aborted) {
        try { await this.cancel(target, request, { reason: 'abort' }); } catch {}
        return this.#settleCancellation(target, request, operation, { timedOut: false, aborted: true });
      }
      state = await this.#recoverExecute(target, request, operation, signal);
    }

    if (state.state === 'completed') return { completion: 'observed', request, target, result: state.result };
    if (state.state === 'failed') throw new EnvironmentBridgeError(state.reason ?? 'bridge execution failed to start', { code: 'remote-error', request, target });
    if (state.state === 'indeterminate') throw new EnvironmentBridgeIndeterminateError(state.reason ?? 'bridge execution start is indeterminate', { request, target });

    const deadline = Date.now() + operation.timeoutMs;
    while (true) {
      if (signal?.aborted) {
        try { await this.cancel(target, request, { reason: 'abort' }); } catch {}
        return this.#settleCancellation(target, request, operation, { timedOut: false, aborted: true });
      }
      if (Date.now() >= deadline) {
        try { await this.cancel(target, request, { reason: 'timeout' }); } catch {}
        return this.#settleCancellation(target, request, operation, { timedOut: true, aborted: false });
      }
      onActivity?.({ request, target, state: 'running' });
      await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
      if (signal?.aborted) continue;
      try {
        state = await this.observe(target, request, { maxOutputBytes: operation.maxOutputBytes });
        if (state.state === 'planned') {
          const body = await this.#send(target, request, 'execute', operation);
          state = executionState(body, operation.maxOutputBytes);
        }
      } catch (error) {
        throw new EnvironmentBridgeIndeterminateError('bridge execution observation failed after start', { request, target, cause: error });
      }
      if (state.state === 'completed') return { completion: 'observed', request, target, result: state.result };
      if (state.state === 'failed') throw new EnvironmentBridgeError(state.reason ?? 'bridge execution failed', { code: 'remote-error', request, target });
      if (state.state === 'absent' || state.state === 'indeterminate') throw new EnvironmentBridgeIndeterminateError(state.reason ?? 'bridge execution state became indeterminate', { request, target });
    }
  }

  async put(rawTarget, source, rawDestination, { request: rawRequest = null, maxBytes = MAX_TRANSFER_BYTES } = {}) {
    const target = targetToken(rawTarget);
    const request = requestToken(rawRequest);
    if (!source || typeof source.read !== 'function') throw new TypeError('bridge put source must provide read()');
    const destination = location(rawDestination, 'bridge put destination', PUT_CLASSES);
    const limit = integer(maxBytes, 'bridge put maxBytes', 1, MAX_TRANSFER_BYTES);
    const hash = createHash('sha256');
    let offset = 0;
    while (true) {
      const chunk = bytesFromPort(await source.read({ offset, limit: Math.min(CHUNK_BYTES, limit - offset) }), 'bridge put source result');
      if (offset + chunk.data.length > limit) throw new EnvironmentBridgeError('bridge put source exceeds the transfer limit', { code: 'limit', request, target });
      hash.update(chunk.data);
      const digest = chunk.eof ? hash.copy().digest('hex') : null;
      const frameBody = { destination, offset, data: chunk.data.toString('base64'), eof: chunk.eof, digest };
      let body;
      try { body = await this.#send(target, request, 'put', frameBody); }
      catch (first) {
        try { body = await this.#send(target, request, 'put', frameBody); }
        catch (second) { throw new EnvironmentBridgeIndeterminateError('bridge put could not reconcile an interrupted chunk', { request, target, cause: second ?? first }); }
      }
      onlyKeys(body, new Set(['nextOffset', 'complete', 'digest']), 'bridge put response');
      const expectedOffset = offset + chunk.data.length;
      if (!Number.isSafeInteger(body.nextOffset) || body.nextOffset !== expectedOffset || typeof body.complete !== 'boolean') {
        throw new EnvironmentBridgeError('bridge put response offset is inconsistent', { code: 'protocol', request, target });
      }
      if (chunk.eof) {
        if (!body.complete || body.digest !== digest) throw new EnvironmentBridgeError('bridge put completion digest is inconsistent', { code: 'protocol', request, target });
        return { request, target, bytes: expectedOffset, digest };
      }
      if (body.complete || body.digest != null) throw new EnvironmentBridgeError('bridge put completed before source EOF', { code: 'protocol', request, target });
      offset = expectedOffset;
      if (offset >= limit) throw new EnvironmentBridgeError('bridge put source exceeds the transfer limit', { code: 'limit', request, target });
    }
  }

  async get(rawTarget, rawSource, sink, { request: rawRequest = null, maxBytes = MAX_TRANSFER_BYTES } = {}) {
    const target = targetToken(rawTarget);
    const request = requestToken(rawRequest);
    const source = location(rawSource, 'bridge get source', GET_CLASSES);
    if (!sink || typeof sink.write !== 'function') throw new TypeError('bridge get sink must provide write()');
    const limit = integer(maxBytes, 'bridge get maxBytes', 1, MAX_TRANSFER_BYTES);
    const chunks = [];
    const hash = createHash('sha256');
    let offset = 0;
    while (true) {
      const body = await this.#send(target, request, 'get', { source, offset, limit: Math.min(CHUNK_BYTES, limit - offset) });
      onlyKeys(body, new Set(['offset', 'data', 'eof', 'digest']), 'bridge get response');
      if (body.offset !== offset || typeof body.eof !== 'boolean') throw new EnvironmentBridgeError('bridge get response offset is inconsistent', { code: 'protocol', request, target });
      const data = canonicalBase64(body.data ?? '', 'bridge get response.data', CHUNK_BYTES);
      if (!body.eof && data.length === 0) throw new EnvironmentBridgeError('bridge get response made no progress', { code: 'protocol', request, target });
      if (offset + data.length > limit) throw new EnvironmentBridgeError('bridge get response exceeds the transfer limit', { code: 'limit', request, target });
      chunks.push(data);
      hash.update(data);
      offset += data.length;
      if (body.eof) {
        const digest = hash.digest('hex');
        if (body.digest !== digest) throw new EnvironmentBridgeError('bridge get response digest is inconsistent', { code: 'protocol', request, target });
        const complete = Buffer.concat(chunks, offset);
        await sink.write({ offset: 0, data: complete, eof: true, digest });
        return { request, target, bytes: offset, digest };
      }
      if (body.digest != null) throw new EnvironmentBridgeError('bridge get response exposed a digest before EOF', { code: 'protocol', request, target });
      if (offset >= limit) throw new EnvironmentBridgeError('bridge get response exceeds the transfer limit', { code: 'limit', request, target });
    }
  }
}
