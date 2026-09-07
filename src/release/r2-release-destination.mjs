import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sameFilesystemIdentity, sameObservedFilesystemIdentity } from '../runtime/local-filesystem-identity.js';
import { normalizeImmutableObjectSourceRequest } from '../runtime/immutable-object-sources/request.js';
import { signS3RequestHeaders } from './s3-request-signature.mjs';

export const R2_RELEASE_DESTINATION_PROTOCOL = 'devbridge/r2-release-destination-v1';
const DIGEST = /^[a-f0-9]{64}$/u;
const LEAF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const MAX_OBJECT_BYTES = 5 * 1024 ** 3;
const MAX_AUTHORITY_BYTES = 16 * 1024 ** 2;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function exact(raw, keys, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !keys.includes(key))) throw new TypeError(`R2 ${name} is invalid`);
  return raw;
}
function signalShape(signal) {
  if (signal != null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('R2 signal is invalid');
  return signal ?? null;
}
function interrupted(signal) {
  if (signal?.aborted) { const error = new Error('R2 operation interrupted'); error.name = 'AbortError'; throw error; }
}
async function waitFor(action, signal) {
  interrupted(signal);
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => { try { interrupted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { interrupted(signal); return action(); }), aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}
function subject(value, maximum) {
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > maximum || typeof value.sha256 !== 'string' || !DIGEST.test(value.sha256)) throw new TypeError('R2 byte subject is invalid');
}
function header(response, name) {
  if (!response?.headers || typeof response.headers.get !== 'function') throw new Error('R2 response headers are invalid');
  return response.headers.get(name);
}
function exactResponse(response, size) {
  if (header(response, 'content-length') !== String(size) || header(response, 'content-range') != null
      || ![null, 'identity'].includes(header(response, 'content-encoding'))) throw new Error('R2 response length or representation mismatch');
}
function discard(response) {
  if (typeof response?.body?.cancel === 'function') Promise.resolve().then(() => response.body.cancel()).catch(() => {});
}
async function* verifiedBody(response, size, digest, signal) {
  const iterator = response.body?.[Symbol.asyncIterator]?.();
  if (!iterator || typeof iterator.next !== 'function') throw new Error('R2 response body is invalid');
  let total = 0, complete = false;
  const measured = createHash('sha256');
  try {
    for (;;) {
      let step;
      try { step = await waitFor(() => iterator.next(), signal); }
      catch { interrupted(signal); throw new Error('R2 body read failed'); }
      if (!step || typeof step.done !== 'boolean') throw new Error('R2 response body step is invalid');
      if (step.done) { complete = true; break; }
      if (!(step.value instanceof Uint8Array) || step.value.length < 1 || step.value.length > size - total) throw new Error('R2 response body exceeds its exact byte count');
      const bytes = Buffer.from(step.value);
      total += bytes.length; measured.update(bytes); yield bytes;
    }
    if (total !== size || measured.digest('hex') !== digest) throw new Error('R2 response bytes do not match authority');
  } finally {
    if (!complete && typeof iterator.return === 'function') Promise.resolve().then(() => iterator.return()).catch(() => {});
  }
}
function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right) && left.size === right.size && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function hashHeldFile(handle, size, signal) {
  const buffer = Buffer.alloc(64 * 1024), measured = createHash('sha256');
  let offset = 0;
  while (offset < size) {
    interrupted(signal);
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (bytesRead === 0) throw new Error('R2 object was truncated');
    measured.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  interrupted(signal);
  return measured.digest('hex');
}

export class R2ReleaseDestination {
  #account; #bucket; #release; #credentials; #fetch; #timeout; #duration; #clock; #public;
  constructor(raw = {}) {
    const value = exact(raw, ['accountId', 'bucket', 'releaseId', 'credentials', 'publicBaseUrl', 'maxDurationMs', 'fetchImpl', 'timeoutSignal', 'clock'], 'destination options');
    if (typeof value.accountId !== 'string' || !/^[a-f0-9]{32}$/u.test(value.accountId)
        || typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value.bucket)
        || typeof value.releaseId !== 'string' || !LEAF.test(value.releaseId)
        || typeof value.credentials !== 'function'
        || !Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1000 || value.maxDurationMs > 2 * 60 * 60 * 1000) throw new TypeError('R2 destination identity or policy is invalid');
    let publicUrl;
    try { publicUrl = new URL(value.publicBaseUrl); } catch { throw new TypeError('R2 public origin is invalid'); }
    if (typeof value.publicBaseUrl !== 'string' || publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.port || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new TypeError('R2 public origin is invalid');
    this.#account = value.accountId; this.#bucket = value.bucket; this.#release = value.releaseId;
    this.#public = publicUrl.origin;
    this.#credentials = value.credentials;
    this.#fetch = value.fetchImpl ?? globalThis.fetch;
    this.#timeout = value.timeoutSignal ?? AbortSignal.timeout;
    this.#clock = value.clock ?? (() => new Date());
    if ([this.#fetch, this.#timeout, this.#clock].some((port) => typeof port !== 'function')) throw new TypeError('R2 transport ports are invalid');
    this.#duration = value.maxDurationMs;
  }
  get protocol() { return R2_RELEASE_DESTINATION_PROTOCOL; }
  get identity() { return `r2-release:${hash(Buffer.from(`${this.#account}/${this.#bucket}/${this.#release}@${this.#public}`))}`; }
  asPublicationDestination() {
    return Object.freeze({ identity: this.identity, objects: Object.freeze({ ensure: (request) => this.ensureObject(request) }), source: Object.freeze({ fetch: (request) => this.fetchObject(request) }), authority: Object.freeze({ ensure: (request) => this.ensureAuthority(request), read: (request) => this.readAuthority(request) }) });
  }
  #signal(caller) {
    const timeout = signalShape(this.#timeout(this.#duration));
    if (timeout == null) throw new TypeError('R2 timeout signal is invalid');
    return caller == null ? timeout : AbortSignal.any([caller, timeout]);
  }
  #authorityKey(name) { return `releases/${this.#release}/${hash(Buffer.from(name))}`; }
  async #request(url, options, signal) {
    let response;
    try {
      response = await waitFor(async () => {
        const received = await this.#fetch(url, { ...options, redirect: 'error', signal });
        if (signal.aborted) discard(received);
        return received;
      }, signal);
    }
    catch { interrupted(signal); throw new Error('R2 HTTP request failed'); }
    if (!response || !Number.isInteger(response.status) || response.redirected === true || (response.url && response.url !== url.href)) { discard(response); throw new Error('R2 HTTP response identity is invalid'); }
    return response;
  }
  async #s3(method, key, signal, body = null, digest = hash(Buffer.alloc(0)), size = null) {
    let credentials;
    try { credentials = await waitFor(() => this.#credentials(), signal); } catch { interrupted(signal); throw new Error('R2 publishing credential unavailable'); }
    exact(credentials, ['accessKeyId', 'secretAccessKey'], 'credential');
    if (!/^[a-f0-9]{32}$/u.test(credentials.accessKeyId ?? '') || !/^[a-f0-9]{64}$/u.test(credentials.secretAccessKey ?? '')) throw new Error('R2 publishing credential is invalid');
    const url = new URL(`https://${this.#account}.r2.cloudflarestorage.com/${this.#bucket}/${key}`);
    const headers = signS3RequestHeaders({ method, url, region: 'auto', date: this.#clock(), accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, headers: {
      'x-amz-content-sha256': digest, 'accept-encoding': 'identity',
      ...(method === 'PUT' ? { 'if-none-match': '*', 'content-length': String(size), 'content-type': 'application/octet-stream', 'cache-control': 'no-transform' } : {}),
    } });
    return this.#request(url, { method, headers, ...(body == null ? {} : { body, duplex: 'half' }) }, signal);
  }
  async #exists(key, size, signal) {
    const response = await this.#s3('HEAD', key, signal);
    try {
      if (response.status === 404) return false;
      if (response.status !== 200) throw new Error(`R2 object observation failed with HTTP ${response.status}`);
      exactResponse(response, size); return true;
    } finally { discard(response); }
  }
  async #put(key, body, size, digest, signal) {
    const response = await this.#s3('PUT', key, signal, body, digest, size);
    discard(response);
    if (![200, 412].includes(response.status)) throw new Error(`R2 conditional upload failed with HTTP ${response.status}`);
    if (!await this.#exists(key, size, signal)) throw new Error('R2 conditional upload was not observed');
  }
  async #publicRead(key, size, digest, signal) {
    const response = await this.#request(new URL(`${this.#public}/${key}`), { method: 'GET', headers: { 'accept-encoding': 'identity' } }, signal);
    try {
      if (response.status !== 200) throw new Error(`R2 public read failed with HTTP ${response.status}`);
      exactResponse(response, size);
    } catch (error) { discard(response); throw error; }
    return verifiedBody(response, size, digest, signal);
  }
  async ensureObject(raw = {}) {
    const request = exact(raw, ['sha256', 'size', 'location', 'signal'], 'object publication');
    subject(request, MAX_OBJECT_BYTES);
    if (typeof request.location !== 'string' || !path.isAbsolute(request.location) || /[\u0000-\u001f\u007f]/u.test(request.location)) throw new TypeError('R2 object location is invalid');
    const signal = this.#signal(signalShape(request.signal)); interrupted(signal);
    const key = `objects/${request.sha256}`;
    if (await this.#exists(key, request.size, signal)) return;
    const resolved = path.resolve(request.location);
    if (!await sameFilesystemIdentity(resolved, await realpath(resolved))) throw new Error('R2 object path must be direct');
    const before = await lstat(resolved, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(request.size)) throw new Error('R2 object must be one exact single-link regular file');
    const handle = await open(resolved, 'r');
    try {
      const held = await handle.stat({ bigint: true });
      if (!sameFile(before, held)) throw new Error('R2 object changed while opening');
      if (await hashHeldFile(handle, request.size, signal) !== request.sha256 || !sameFile(held, await handle.stat({ bigint: true })) || !sameFile(held, await lstat(resolved, { bigint: true }))) throw new Error('R2 local object identity mismatch');
      const stream = handle.createReadStream({ autoClose: false, start: 0, end: request.size - 1 });
      try {
        await this.#put(key, stream, request.size, request.sha256, signal);
        // Filesystem timestamps can remain unchanged across a same-size write.
        // Rehash the held file; metadata alone is not byte-stability evidence.
        if (await hashHeldFile(handle, request.size, signal) !== request.sha256 || !sameFile(held, await handle.stat({ bigint: true })) || !sameFile(held, await lstat(resolved, { bigint: true }))) throw new Error('R2 object changed while uploading');
      }
      finally { stream.destroy(); }
    } finally { await handle.close(); }
  }
  async fetchObject(raw = {}) {
    const request = normalizeImmutableObjectSourceRequest(raw);
    subject(request.chunk, MAX_OBJECT_BYTES);
    const signal = this.#signal(request.signal);
    return Object.freeze({ body: await this.#publicRead(`objects/${request.chunk.sha256}`, request.chunk.size, request.chunk.sha256, signal) });
  }
  #authority(raw, writing) {
    const value = exact(raw, writing ? ['name', 'bytes', 'size', 'sha256', 'signal'] : ['name', 'size', 'sha256', 'signal'], 'authority request');
    subject(value, MAX_AUTHORITY_BYTES);
    if (typeof value.name !== 'string' || !LEAF.test(value.name)) throw new TypeError('R2 authority name is invalid');
    const bytes = writing && value.bytes instanceof Uint8Array ? Buffer.from(value.bytes) : null;
    if (writing && (bytes == null || bytes.length !== value.size || hash(bytes) !== value.sha256)) throw new Error('R2 authority bytes do not match subject');
    return { ...value, bytes, signal: this.#signal(signalShape(value.signal)) };
  }
  async ensureAuthority(raw = {}) {
    const request = this.#authority(raw, true), key = this.#authorityKey(request.name);
    if (!await this.#exists(key, request.size, request.signal)) await this.#put(key, request.bytes, request.size, request.sha256, request.signal);
  }
  async readAuthority(raw = {}) {
    const request = this.#authority(raw, false);
    const body = await this.#publicRead(this.#authorityKey(request.name), request.size, request.sha256, request.signal);
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks, request.size);
  }
}
