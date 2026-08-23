import { open, lstat, rm } from 'node:fs/promises';
import path from 'node:path';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1000;

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

  constructor({
    fetchImpl = globalThis.fetch,
    allowedHosts,
    maxRedirects = 5,
    maxBytes = DEFAULT_MAX_BYTES,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('download fetch implementation is invalid');
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 16) throw new TypeError('download maxRedirects is invalid');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('download maxBytes is invalid');
    if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1_000) throw new TypeError('download maxDurationMs is invalid');
    this.#fetch = fetchImpl;
    this.#allowedHosts = normalizeHosts(allowedHosts);
    this.#maxRedirects = maxRedirects;
    this.#maxBytes = maxBytes;
    this.#maxDurationMs = maxDurationMs;
  }

  async download({ url, destination } = {}) {
    if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) throw new TypeError('download destination is invalid');
    const output = path.resolve(destination);
    await realParent(output);
    await requireAbsent(output);
    const signal = AbortSignal.timeout(this.#maxDurationMs);
    let current = approvedUrl(url, this.#allowedHosts);
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
      throw error;
    }
  }
}

export function createHttpsFileDownload(options) {
  const adapter = new HttpsFileDownload(options);
  return (request) => adapter.download(request);
}
