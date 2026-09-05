import { createHash } from 'node:crypto';
import https from 'node:https';

export const UBUNTU_SNAPSHOT_ARCHIVE_HTTPS_SOURCE_PROTOCOL = 'devbridge/ubuntu-snapshot-archive-https-source-v1';

const DIGEST = /^[a-f0-9]{64}$/u;
const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function archivePath(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.startsWith('/') || value.endsWith('/')
      || value.includes('\\') || value.includes('//') || /[?#\u0000-\u001f\u007f]/u.test(value)
      || !/^[A-Za-z0-9._+%~/-]+$/u.test(value)) throw new TypeError(`${name} is invalid`);
  for (const segment of value.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new TypeError(`${name} is invalid`); }
    if (!segment || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')
        || /[\u0000-\u001f\u007f]/u.test(decoded)) throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function baseUrl(raw) {
  let value;
  try { value = new URL(raw); } catch { throw new TypeError('Ubuntu snapshot archive base URL is invalid'); }
  if (value.protocol !== 'https:' || value.username || value.password || value.port || value.search || value.hash
      || !value.hostname || !value.pathname.endsWith('/')) {
    throw new TypeError('Ubuntu snapshot archive base URL is not approved HTTPS');
  }
  return value;
}

function signalShape(signal, name) {
  if (signal != null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError(`${name} is invalid`);
  }
  return signal ?? null;
}

function interrupted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Ubuntu snapshot archive read was interrupted', { cause: signal.reason });
  error.name = 'AbortError';
  throw error;
}

function abortable(work, signal) {
  interrupted(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      try { interrupted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(work).then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
}

function header(response, name) {
  if (!response?.headers || typeof response.headers.get !== 'function') fail('Ubuntu snapshot archive response headers are invalid');
  return response.headers.get(name);
}

function declaredLength(response) {
  const raw = header(response, 'content-length');
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/u.test(raw.trim())) fail('Ubuntu snapshot archive content length is missing or invalid');
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) fail('Ubuntu snapshot archive content length is invalid');
  return value;
}

// Archive identity names the wire object, not a fetch-decoded representation.
// Node HTTPS supplies those bytes directly and never follows redirects.
function rawHttpsResponse(url, { signal, headers }) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers }, (response) => {
      // Header rejection can abort before a body iterator attaches its listener.
      response.on('error', () => {});
      resolve({
        status: response.statusCode,
        redirected: false,
        headers: { get(name) {
          const value = response.headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        } },
        body: response,
      });
    });
    request.on('error', reject);
  });
}

function normalizeRequest(raw) {
  const value = exactObject(raw, new Set(['path', 'maximum', 'size', 'sha256', 'signal']), 'Ubuntu snapshot archive read request');
  const selectedPath = archivePath(value.path, 'Ubuntu snapshot archive read path');
  if (!Number.isSafeInteger(value.maximum) || value.maximum < 1 || value.maximum > MAX_RESPONSE_BYTES) {
    throw new TypeError('Ubuntu snapshot archive read maximum is invalid');
  }
  const hasSize = value.size != null;
  const hasDigest = value.sha256 != null;
  if (hasSize !== hasDigest) throw new TypeError('Ubuntu snapshot archive exact identity is incomplete');
  if (hasSize && (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > value.maximum
      || typeof value.sha256 !== 'string' || !DIGEST.test(value.sha256))) {
    throw new TypeError('Ubuntu snapshot archive exact identity is invalid');
  }
  return Object.freeze({
    path: selectedPath,
    maximum: value.maximum,
    ...(hasSize ? { size: value.size, sha256: value.sha256 } : {}),
    signal: signalShape(value.signal, 'Ubuntu snapshot archive read signal'),
  });
}

async function readBody(body, signal, maximum) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') fail('Ubuntu snapshot archive response body is invalid');
  const iterator = body[Symbol.asyncIterator]();
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const result = await abortable(() => iterator.next(), signal);
      if (!result || typeof result.done !== 'boolean') fail('Ubuntu snapshot archive body iterator returned an invalid result');
      if (result.done) { complete = true; break; }
      if (!(result.value instanceof Uint8Array) || result.value.byteLength < 1) fail('Ubuntu snapshot archive body chunk is invalid');
      total += result.value.byteLength;
      if (total > maximum) fail('Ubuntu snapshot archive response exceeds its byte bound');
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    if (!complete && typeof iterator.return === 'function') Promise.resolve().then(() => iterator.return()).catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

export class UbuntuSnapshotArchiveHttpsSource {
  #baseUrl;
  #snapshot;
  #maxDurationMs;
  #fetch;
  #timeoutSignal;

  constructor(raw = {}) {
    const value = exactObject(raw, new Set(['baseUrl', 'snapshot', 'maxDurationMs', 'fetchImpl', 'timeoutSignal']), 'Ubuntu snapshot archive source options');
    if (typeof value.snapshot !== 'string' || !SNAPSHOT.test(value.snapshot)) throw new TypeError('Ubuntu snapshot archive snapshot is invalid');
    if (!Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1_000 || value.maxDurationMs > MAX_DURATION_MS) {
      throw new TypeError('Ubuntu snapshot archive duration is invalid');
    }
    const fetchImpl = value.fetchImpl ?? rawHttpsResponse;
    const timeoutSignal = value.timeoutSignal ?? AbortSignal.timeout;
    if (typeof fetchImpl !== 'function') throw new TypeError('Ubuntu snapshot archive fetch implementation is invalid');
    if (typeof timeoutSignal !== 'function') throw new TypeError('Ubuntu snapshot archive timeout signal factory is invalid');
    this.#baseUrl = baseUrl(value.baseUrl);
    this.#snapshot = value.snapshot;
    this.#maxDurationMs = value.maxDurationMs;
    this.#fetch = fetchImpl;
    this.#timeoutSignal = timeoutSignal;
  }

  async read(raw = {}) {
    const request = normalizeRequest(raw);
    interrupted(request.signal);
    const durationSignal = signalShape(this.#timeoutSignal(this.#maxDurationMs), 'Ubuntu snapshot archive timeout signal');
    if (durationSignal == null) throw new TypeError('Ubuntu snapshot archive timeout signal is invalid');
    const operation = new AbortController();
    const signal = AbortSignal.any([operation.signal, durationSignal, ...(request.signal == null ? [] : [request.signal])]);
    interrupted(signal);
    const url = new URL(`${this.#snapshot}/${request.path}`, this.#baseUrl);
    try {
      const response = await abortable(() => this.#fetch(url, {
        redirect: 'error',
        signal,
        headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' },
      }), signal);
      interrupted(signal);
      if (!response || !Number.isInteger(response.status)) fail('Ubuntu snapshot archive response is invalid');
      if (response.status !== 200) fail(`Ubuntu snapshot archive read failed with HTTP ${response.status}`);
      if (response.redirected === true) fail('Ubuntu snapshot archive returned a redirected response');
      if (header(response, 'content-range') != null) fail('Ubuntu snapshot archive returned an unexpected range');
      const encoding = header(response, 'content-encoding')?.trim().toLowerCase();
      // A gzip-coded response is useful only if its unmodified bytes match an
      // already authenticated archive object. Never decode or infer identity.
      if (encoding != null && encoding !== 'identity' && !(encoding === 'gzip' && request.size != null)) {
        fail('Ubuntu snapshot archive returned an unsupported or unpinned encoding');
      }
      const length = declaredLength(response);
      if (length > request.maximum) fail('Ubuntu snapshot archive declared byte count exceeds its bound');
      if (request.size != null && length !== request.size) fail('Ubuntu snapshot archive declared byte count does not match authority');
      const bytes = await readBody(response.body, signal, request.maximum);
      if (bytes.length !== length) fail('Ubuntu snapshot archive response byte count changed');
      if (request.size != null && (bytes.length !== request.size || sha256(bytes) !== request.sha256)) {
        fail('Ubuntu snapshot archive bytes do not match exact authority');
      }
      return bytes;
    } finally {
      operation.abort();
    }
  }
}
