import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const CHECKPOINT_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function normalizeHosts(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) throw new TypeError('download allowedHosts is invalid');
  const hosts = raw.map((value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/u.test(value)) throw new TypeError('download allowed host is invalid');
    return value.toLowerCase();
  });
  return new Set(hosts);
}

function approvedUrl(raw, allowedHosts) {
  let value;
  try { value = new URL(raw); } catch { throw new TypeError('download URL is invalid'); }
  if (value.protocol !== 'https:' || value.username || value.password || value.port || value.hash) throw new Error('download URL is not approved HTTPS');
  if (!allowedHosts.has(value.hostname.toLowerCase())) throw new Error('download URL host is not approved');
  return value;
}

function normalizeResume(raw, maxBytes) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('download resume identity is invalid');
  const allowed = new Set(['bytes', 'sha256']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`download resume identity.${key} is not allowed`);
  if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 1 || raw.bytes > maxBytes) throw new TypeError('download resume identity.bytes is invalid');
  if (typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) throw new TypeError('download resume identity.sha256 is invalid');
  return Object.freeze({ bytes: raw.bytes, sha256: raw.sha256 });
}

function errorCode(error) {
  const values = [error?.code, error?.cause?.code];
  return values.find((value) => typeof value === 'string') ?? null;
}

function errorMessage(error) {
  const values = [error?.message, error?.cause?.message];
  const selected = values.find((value) => typeof value === 'string' && value.trim().length > 0);
  return (selected ?? 'unknown transport error').trim().replace(/[\r\n]+/gu, ' ').slice(0, 512);
}

function transientTransportError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = errorCode(error);
  if (code && TRANSIENT_CODES.has(code)) return true;
  const messages = [error?.message, error?.cause?.message]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());
  return messages.includes('terminated');
}

function durationError(error, signal) {
  return signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

async function realParent(destination) {
  const parent = path.dirname(destination);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('download destination parent must be a real directory');
}

async function requireAbsent(destination) {
  try {
    await lstat(destination);
    throw new Error('download destination already exists');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

async function regularSize(location, label, { absent = false } = {}) {
  try {
    const info = await lstat(location);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real regular file`);
    return info.size;
  } catch (error) {
    if (absent && error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function sha256File(location) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function contentLength(response) {
  const value = Number(response.headers?.get?.('content-length'));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function contentRange(response) {
  const value = response.headers?.get?.('content-range');
  if (typeof value !== 'string') return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total < 1 || end >= total) return null;
  return { start, end, total };
}

async function requestWithRedirects(fetchImpl, initial, allowedHosts, maxRedirects, signal, headers = undefined) {
  let current = initial;
  let response;
  for (let redirects = 0; ; redirects += 1) {
    response = await fetchImpl(current, { redirect: 'manual', signal, ...(headers ? { headers } : {}) });
    if (!response || !Number.isInteger(response.status)) throw new Error('download response is invalid');
    if (!REDIRECTS.has(response.status)) return { current, response };
    if (redirects >= maxRedirects) throw new Error('download redirect limit exceeded');
    const location = response.headers?.get?.('location');
    if (typeof location !== 'string' || location.length === 0) throw new Error('download redirect location is missing');
    current = approvedUrl(new URL(location, current).toString(), allowedHosts);
  }
}

async function writeBody({ response, location, offset, maxBytes, expectedBytes = null }) {
  const handle = offset === 0 ? await open(location, 'wx', 0o600) : await open(location, 'r+');
  let bytes = offset;
  let checkpoint = offset;
  try {
    if (offset > 0) {
      const observed = await regularSize(location, 'download partial');
      if (observed !== offset) throw new Error('download partial changed before continuation');
    }
    try {
      for await (const chunk of response.body) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > maxBytes) throw new Error('download exceeds its byte bound');
        if (expectedBytes != null && bytes > expectedBytes) throw new Error('download exceeds its expected byte count');
        const { bytesWritten } = await handle.write(data, 0, data.length, bytes - data.length);
        if (bytesWritten !== data.length) throw new Error('download write was incomplete');
        if (bytes - checkpoint >= CHECKPOINT_BYTES) {
          await handle.sync();
          checkpoint = bytes;
        }
      }
      await handle.sync();
    } catch (error) {
      await handle.sync().catch(() => {});
      throw error;
    }
  } finally {
    await handle.close();
  }
  return bytes;
}

export class HttpsFileDownload {
  #fetch;
  #allowedHosts;
  #maxRedirects;
  #maxBytes;
  #maxDurationMs;
  #maxAttempts;

  constructor({
    fetchImpl = globalThis.fetch,
    allowedHosts,
    maxRedirects = 5,
    maxBytes = DEFAULT_MAX_BYTES,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('download fetch implementation is invalid');
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 16) throw new TypeError('download maxRedirects is invalid');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('download maxBytes is invalid');
    if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1_000) throw new TypeError('download maxDurationMs is invalid');
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new TypeError('download maxAttempts is invalid');
    this.#fetch = fetchImpl;
    this.#allowedHosts = normalizeHosts(allowedHosts);
    this.#maxRedirects = maxRedirects;
    this.#maxBytes = maxBytes;
    this.#maxDurationMs = maxDurationMs;
    this.#maxAttempts = maxAttempts;
  }

  async #cleanAttempt({ initial, output, signal }) {
    let created = false;
    try {
      const { current, response } = await requestWithRedirects(this.#fetch, initial, this.#allowedHosts, this.#maxRedirects, signal);
      if (response.status < 200 || response.status >= 300 || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
      const declared = contentLength(response);
      if (declared != null && declared > this.#maxBytes) throw new Error('download exceeds its byte bound');
      created = true;
      const bytes = await writeBody({ response, location: output, offset: 0, maxBytes: this.#maxBytes });
      return Object.freeze({ finalUrl: current.toString(), bytes, resumedBytes: 0 });
    } catch (error) {
      if (created) await rm(output, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #resumableAttempt({ initial, output, partial, resume, signal }) {
    let offset = await regularSize(partial, 'download partial', { absent: true }) ?? 0;
    if (offset > resume.bytes || offset > this.#maxBytes) {
      await rm(partial, { force: true });
      offset = 0;
    }
    if (offset === resume.bytes) {
      if (await sha256File(partial) === resume.sha256) {
        await rename(partial, output);
        return Object.freeze({ finalUrl: initial.toString(), bytes: resume.bytes, resumedBytes: resume.bytes });
      }
      await rm(partial, { force: true });
      offset = 0;
    }

    const requestedOffset = offset;
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
    const { current, response } = await requestWithRedirects(this.#fetch, initial, this.#allowedHosts, this.#maxRedirects, signal, headers);
    if (!response.body) throw new Error(`download failed with HTTP ${response.status}`);

    if (offset > 0 && response.status === 200) {
      await rm(partial, { force: true });
      offset = 0;
    } else if (response.status === 206) {
      const range = contentRange(response);
      if (!range || range.start !== offset || range.total !== resume.bytes) throw new Error('download continuation range does not match expected identity');
      const declared = contentLength(response);
      if (declared != null && declared !== range.end - range.start + 1) throw new Error('download continuation length does not match its range');
    } else if (response.status < 200 || response.status >= 300) {
      throw new Error(`download failed with HTTP ${response.status}`);
    } else if (offset > 0) {
      throw new Error('download server did not honor continuation request');
    }

    const declared = contentLength(response);
    if (offset === 0 && declared != null && declared !== resume.bytes) throw new Error('download declared byte count does not match expected identity');
    const bytes = await writeBody({ response, location: partial, offset, maxBytes: this.#maxBytes, expectedBytes: resume.bytes });
    if (bytes !== resume.bytes) {
      const error = new Error(`download ended at ${bytes} of ${resume.bytes} expected bytes`);
      error.code = 'UND_ERR_SOCKET';
      throw error;
    }
    if (await sha256File(partial) !== resume.sha256) {
      await rm(partial, { force: true });
      throw new Error('download digest does not match expected identity');
    }
    await rename(partial, output);
    return Object.freeze({ finalUrl: current.toString(), bytes, resumedBytes: requestedOffset });
  }

  async download({ url, destination, resume = null } = {}) {
    if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) throw new TypeError('download destination is invalid');
    const output = path.resolve(destination);
    await realParent(output);
    await requireAbsent(output);
    const expected = normalizeResume(resume, this.#maxBytes);
    const partial = `${output}.partial`;
    if (expected == null && (await regularSize(partial, 'download partial', { absent: true })) != null) {
      throw new Error('download partial exists without a resumable identity');
    }
    const signal = AbortSignal.timeout(this.#maxDurationMs);
    const initial = approvedUrl(url, this.#allowedHosts);

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        if (expected) return await this.#resumableAttempt({ initial, output, partial, resume: expected, signal });
        return await this.#cleanAttempt({ initial, output, signal });
      } catch (error) {
        const timedOut = durationError(error, signal);
        const retryable = !timedOut && transientTransportError(error);
        if (retryable && attempt < this.#maxAttempts) continue;
        if (expected == null || (!retryable && !timedOut)) await rm(partial, { force: true }).catch(() => {});
        if (timedOut && expected) throw new Error(`download duration limit reached; ${await regularSize(partial, 'download partial', { absent: true }) ?? 0} verified-position byte(s) preserved for restart`, { cause: error });
        if (retryable) throw new Error(`download transport failed after ${attempt} attempt(s): ${errorMessage(error)}; partial state preserved for restart`, { cause: error });
        throw error;
      }
    }

    throw new Error('download attempt policy exhausted unexpectedly');
  }
}

export function createHttpsFileDownload(options) {
  const adapter = new HttpsFileDownload(options);
  return (request) => adapter.download(request);
}
