import { open, lstat, rm } from 'node:fs/promises';
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
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return false;
  const code = errorCode(error);
  if (code && TRANSIENT_CODES.has(code)) return true;
  const messages = [error?.message, error?.cause?.message]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());
  return messages.includes('terminated');
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

  async download({ url, destination } = {}) {
    if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) throw new TypeError('download destination is invalid');
    const output = path.resolve(destination);
    await realParent(output);
    await requireAbsent(output);
    const signal = AbortSignal.timeout(this.#maxDurationMs);
    const initial = approvedUrl(url, this.#allowedHosts);

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let current = initial;
      let response;
      let created = false;
      try {
        for (let redirects = 0; ; redirects += 1) {
          response = await this.#fetch(current, { redirect: 'manual', signal });
          if (!response || !Number.isInteger(response.status)) throw new Error('download response is invalid');
          if (!REDIRECTS.has(response.status)) break;
          if (redirects >= this.#maxRedirects) throw new Error('download redirect limit exceeded');
          const location = response.headers?.get?.('location');
          if (typeof location !== 'string' || location.length === 0) throw new Error('download redirect location is missing');
          current = approvedUrl(new URL(location, current).toString(), this.#allowedHosts);
        }

        if (response.status < 200 || response.status >= 300 || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > this.#maxBytes) throw new Error('download exceeds its byte bound');

        const handle = await open(output, 'wx', 0o600);
        created = true;
        let bytes = 0;
        try {
          for await (const chunk of response.body) {
            const data = Buffer.from(chunk);
            bytes += data.length;
            if (bytes > this.#maxBytes) throw new Error('download exceeds its byte bound');
            await handle.write(data);
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        return Object.freeze({ finalUrl: current.toString(), bytes });
      } catch (error) {
        if (created) await rm(output, { force: true }).catch(() => {});
        const retryable = !signal.aborted && transientTransportError(error);
        if (retryable && attempt < this.#maxAttempts) continue;
        if (retryable) throw new Error(`download transport failed after ${attempt} attempt(s): ${errorMessage(error)}`, { cause: error });
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
