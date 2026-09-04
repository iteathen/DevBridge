import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  sameFilesystemIdentity,
  sameObservedFilesystemIdentity,
} from '../runtime/local-filesystem-identity.js';
import {
  immutableObjectSourceAbort,
  normalizeImmutableObjectSourceRequest,
} from '../runtime/immutable-object-sources/request.js';

export const GITHUB_RELEASE_DESTINATION_PROTOCOL = 'devbridge/github-release-destination-v1';

const SAFE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/u;
const SAFE_LEAF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_AUTHORITY_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const ASSETS_PER_PAGE = 100;
const MAX_ASSET_PAGES = 164;
const API_VERSION = '2022-11-28';

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function exactPositive(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} is invalid`);
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
  immutableObjectSourceAbort(signal);
}

function assetName(kind, value) {
  return `devbridge-${kind}-${kind === 'object' ? value : sha256(Buffer.from(value, 'utf8'))}`;
}

function requestHeaders(token, accept) {
  return {
    accept,
    'accept-encoding': 'identity',
    authorization: `Bearer ${token}`,
    'user-agent': 'DevBridge-release-destination',
    'x-github-api-version': API_VERSION,
  };
}

function responseHeader(response, name) {
  if (!response?.headers || typeof response.headers.get !== 'function') fail('GitHub Release response headers are invalid');
  return response.headers.get(name);
}

function exactContentLength(response, expected, name) {
  const raw = responseHeader(response, 'content-length');
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(raw.trim())) fail(`${name} content length is missing or invalid`);
  const observed = Number(raw.trim());
  if (!Number.isSafeInteger(observed) || observed !== expected) fail(`${name} content length does not match authority`);
}

async function* boundedBody(body, signal, expected, name) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') fail(`${name} body is invalid`);
  const iterator = body[Symbol.asyncIterator]();
  let total = 0;
  let complete = false;
  try {
    while (true) {
      interrupted(signal);
      const result = await iterator.next();
      if (!result || typeof result.done !== 'boolean') fail(`${name} body iterator returned an invalid result`);
      if (result.done) { complete = true; break; }
      if (!(result.value instanceof Uint8Array) || result.value.byteLength < 1) fail(`${name} body chunk is invalid`);
      total += result.value.byteLength;
      if (total > expected) fail(`${name} body exceeds its exact byte count`);
      yield Buffer.from(result.value);
    }
  } finally {
    if (!complete && typeof iterator.return === 'function') Promise.resolve().then(() => iterator.return()).catch(() => {});
  }
  if (total !== expected) fail(`${name} body did not match its exact byte count`);
}

async function readBounded(response, maximum, signal, name) {
  const chunks = [];
  let total = 0;
  for await (const chunk of boundedBody(response.body, signal, maximum, name)) {
    total += chunk.length;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function readJson(response, signal, name) {
  const declared = responseHeader(response, 'content-length');
  if (declared != null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared.trim()) || Number(declared) > MAX_JSON_BYTES) fail(`${name} JSON length is invalid`);
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') fail(`${name} JSON body is invalid`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    interrupted(signal);
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1) fail(`${name} JSON body chunk is invalid`);
    total += chunk.byteLength;
    if (total > MAX_JSON_BYTES) fail(`${name} JSON body exceeds its byte bound`);
    chunks.push(Buffer.from(chunk));
  }
  interrupted(signal);
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { fail(`${name} JSON body is invalid`); }
}

function assetMetadata(raw, expectedName, expectedSize, expectedDigest, apiAssetUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !Number.isSafeInteger(raw.id) || raw.id < 1
      || raw.name !== expectedName || raw.state !== 'uploaded'
      || raw.size !== expectedSize || raw.url !== `${apiAssetUrl}/${raw.id}`) {
    fail(`GitHub Release asset metadata does not match ${expectedName}`);
  }
  if (raw.digest != null && raw.digest !== `sha256:${expectedDigest}`) {
    fail(`GitHub Release asset digest does not match ${expectedName}`);
  }
  return Object.freeze({
    id: raw.id,
    name: raw.name,
    size: raw.size,
    digest: raw.digest ?? null,
    url: raw.url,
    state: raw.state,
  });
}

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function approvedRedirect(raw) {
  let value;
  try { value = new URL(raw); } catch { fail('GitHub Release asset redirect is invalid'); }
  if (value.protocol !== 'https:' || value.username || value.password || value.port
      || value.hash || !(value.hostname === 'release-assets.githubusercontent.com'
        || value.hostname.endsWith('.githubusercontent.com'))) {
    fail('GitHub Release asset redirect left the approved storage boundary');
  }
  return value;
}

function authorityRequest(raw, purpose) {
  const value = exactObject(raw, new Set(['name', 'bytes', 'size', 'sha256', 'signal']), `GitHub Release authority ${purpose}`);
  if (typeof value.name !== 'string' || !SAFE_LEAF.test(value.name)) throw new TypeError(`GitHub Release authority ${purpose} name is invalid`);
  const size = exactPositive(value.size, `GitHub Release authority ${purpose} size`, MAX_AUTHORITY_BYTES);
  if (typeof value.sha256 !== 'string' || !DIGEST.test(value.sha256)) throw new TypeError(`GitHub Release authority ${purpose} digest is invalid`);
  if (purpose === 'publication') {
    if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength !== size || sha256(value.bytes) !== value.sha256) {
      fail('GitHub Release authority publication bytes do not match authority');
    }
  } else if (value.bytes != null) {
    throw new TypeError('GitHub Release authority read.bytes is unsupported');
  }
  return Object.freeze({
    name: value.name,
    ...(purpose === 'publication' ? { bytes: Buffer.from(value.bytes) } : {}),
    size,
    sha256: value.sha256,
    signal: signalShape(value.signal, `GitHub Release authority ${purpose} signal`),
  });
}

export class GitHubReleaseDestination {
  #owner;
  #repository;
  #releaseId;
  #token;
  #fetch;
  #timeoutSignal;
  #maxDurationMs;
  #apiReleaseUrl;
  #apiAssetUrl;
  #uploadUrl;
  #assets = null;

  constructor(raw = {}) {
    const value = exactObject(raw, new Set([
      'owner', 'repository', 'releaseId', 'token', 'maxDurationMs', 'fetchImpl', 'timeoutSignal',
    ]), 'GitHub Release destination options');
    if (typeof value.owner !== 'string' || !SAFE_OWNER.test(value.owner)) throw new TypeError('GitHub Release destination owner is invalid');
    if (typeof value.repository !== 'string' || !SAFE_REPOSITORY.test(value.repository)) throw new TypeError('GitHub Release destination repository is invalid');
    this.#releaseId = exactPositive(value.releaseId, 'GitHub Release destination release identity');
    if (typeof value.token !== 'function') throw new TypeError('GitHub Release destination credential port is invalid');
    if (!Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1_000 || value.maxDurationMs > MAX_DURATION_MS) {
      throw new TypeError('GitHub Release destination duration is invalid');
    }
    this.#maxDurationMs = value.maxDurationMs;
    this.#fetch = value.fetchImpl ?? globalThis.fetch;
    this.#timeoutSignal = value.timeoutSignal ?? AbortSignal.timeout;
    if (typeof this.#fetch !== 'function' || typeof this.#timeoutSignal !== 'function') {
      throw new TypeError('GitHub Release destination HTTP ports are invalid');
    }
    this.#owner = value.owner;
    this.#repository = value.repository;
    this.#token = value.token;
    this.#apiReleaseUrl = `https://api.github.com/repos/${this.#owner}/${this.#repository}/releases/${this.#releaseId}`;
    this.#apiAssetUrl = `https://api.github.com/repos/${this.#owner}/${this.#repository}/releases/assets`;
    this.#uploadUrl = `https://uploads.github.com/repos/${this.#owner}/${this.#repository}/releases/${this.#releaseId}/assets`;
  }

  get protocol() { return GITHUB_RELEASE_DESTINATION_PROTOCOL; }

  get identity() {
    return `github-release:${sha256(Buffer.from(`${this.#owner}/${this.#repository}#${this.#releaseId}`, 'utf8'))}`;
  }

  asPublicationDestination() {
    return Object.freeze({
      identity: this.identity,
      objects: Object.freeze({ ensure: (request) => this.ensureObject(request) }),
      source: Object.freeze({ fetch: (request) => this.fetchObject(request) }),
      authority: Object.freeze({
        ensure: (request) => this.ensureAuthority(request),
        read: (request) => this.readAuthority(request),
      }),
    });
  }

  #signal(caller, name) {
    const duration = signalShape(this.#timeoutSignal(this.#maxDurationMs), `${name} timeout signal`);
    if (duration == null) throw new TypeError(`${name} timeout signal is invalid`);
    return caller == null ? duration : AbortSignal.any([caller, duration]);
  }

  async #credential() {
    const token = await this.#token();
    if (typeof token !== 'string' || token.length < 1 || token.length > 4096 || /[^\x21-\x7e]/u.test(token)) {
      fail('GitHub Release destination credential is unavailable');
    }
    return token;
  }

  async #apiFetch(url, options, signal, accept = 'application/vnd.github+json') {
    interrupted(signal);
    const token = await this.#credential();
    interrupted(signal);
    const response = await this.#fetch(url, {
      ...options,
      redirect: 'manual',
      signal,
      headers: { ...requestHeaders(token, accept), ...(options.headers ?? {}) },
    });
    interrupted(signal);
    if (!response || !Number.isInteger(response.status)) fail('GitHub Release HTTP response is invalid');
    return response;
  }

  async #loadAssets(signal) {
    if (this.#assets != null) return this.#assets;
    const selected = new Map();
    for (let page = 1; page <= MAX_ASSET_PAGES; page += 1) {
      const url = `${this.#apiReleaseUrl}/assets?per_page=${ASSETS_PER_PAGE}&page=${page}`;
      const response = await this.#apiFetch(url, { method: 'GET' }, signal);
      if (response.status !== 200) fail(`GitHub Release asset listing failed with HTTP ${response.status}`);
      const values = await readJson(response, signal, 'GitHub Release asset listing');
      if (!Array.isArray(values) || values.length > ASSETS_PER_PAGE) fail('GitHub Release asset listing is invalid');
      for (const asset of values) {
        if (!asset || typeof asset !== 'object' || Array.isArray(asset) || typeof asset.name !== 'string'
            || asset.name.length < 1 || asset.name.length > 255 || selected.has(asset.name)) {
          fail('GitHub Release asset listing contains ambiguous metadata');
        }
        selected.set(asset.name, asset);
      }
      if (values.length < ASSETS_PER_PAGE) {
        this.#assets = selected;
        return selected;
      }
    }
    fail('GitHub Release asset listing exceeded its page bound');
  }

  async #findAsset(name, size, digest, signal) {
    const values = await this.#loadAssets(signal);
    const value = values.get(name);
    return value == null ? null : assetMetadata(value, name, size, digest, this.#apiAssetUrl);
  }

  async #uploadBytes(name, bytes, size, digest, signal, extra = {}) {
    const url = `${this.#uploadUrl}?name=${encodeURIComponent(name)}`;
    const response = await this.#apiFetch(url, {
      method: 'POST',
      body: bytes,
      duplex: 'half',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(size),
      },
      ...extra,
    }, signal);
    if (response.status !== 201) fail(`GitHub Release asset upload failed with HTTP ${response.status}`);
    const uploaded = assetMetadata(await readJson(response, signal, 'GitHub Release asset upload'), name, size, digest, this.#apiAssetUrl);
    this.#assets.set(name, uploaded);
  }

  async ensureObject(raw = {}) {
    const value = exactObject(raw, new Set(['sha256', 'size', 'location', 'signal']), 'GitHub Release object publication');
    if (typeof value.sha256 !== 'string' || !DIGEST.test(value.sha256)) throw new TypeError('GitHub Release object publication digest is invalid');
    const size = exactPositive(value.size, 'GitHub Release object publication size');
    if (typeof value.location !== 'string' || !path.isAbsolute(value.location) || value.location.includes('\0')) {
      throw new TypeError('GitHub Release object publication location is invalid');
    }
    const callerSignal = signalShape(value.signal, 'GitHub Release object publication signal');
    const signal = this.#signal(callerSignal, 'GitHub Release object publication');
    interrupted(signal);
    const name = assetName('object', value.sha256);
    if (await this.#findAsset(name, size, value.sha256, signal) != null) return;

    const resolved = path.resolve(value.location);
    const canonical = await realpath(resolved);
    if (!await sameFilesystemIdentity(resolved, canonical)) fail('GitHub Release object must use a direct nonsymbolic path');
    const before = await lstat(resolved, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(size)) {
      fail('GitHub Release object must be one exact unlinked regular file');
    }
    const handle = await open(resolved, 'r');
    try {
      const held = await handle.stat({ bigint: true });
      if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) fail('GitHub Release object changed while opening');
      const stream = createReadStream(resolved, { fd: handle.fd, autoClose: false, start: 0, end: size - 1 });
      await this.#uploadBytes(name, stream, size, value.sha256, signal);
      const afterHeld = await handle.stat({ bigint: true });
      const afterPath = await lstat(resolved, { bigint: true });
      if (!sameFile(held, afterHeld) || !sameFile(held, afterPath)) fail('GitHub Release object changed while uploading');
    } finally { await handle.close(); }
  }

  async #download(asset, expectedSize, signal) {
    let response = await this.#apiFetch(asset.url, { method: 'GET' }, signal, 'application/octet-stream');
    if (response.status === 302) {
      const location = approvedRedirect(responseHeader(response, 'location'));
      response = await this.#fetch(location, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' },
      });
      interrupted(signal);
      if (!response || !Number.isInteger(response.status)) fail('GitHub Release storage response is invalid');
    }
    if (response.status !== 200) fail(`GitHub Release asset read failed with HTTP ${response.status}`);
    if (response.redirected === true || responseHeader(response, 'content-range') != null) fail('GitHub Release asset read changed transport identity');
    const encoding = responseHeader(response, 'content-encoding');
    if (encoding != null && encoding.trim().toLowerCase() !== 'identity') fail('GitHub Release asset read returned transformed bytes');
    exactContentLength(response, expectedSize, 'GitHub Release asset read');
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') fail('GitHub Release asset read body is invalid');
    return response;
  }

  async fetchObject(raw = {}) {
    const request = normalizeImmutableObjectSourceRequest(raw);
    const signal = this.#signal(request.signal, 'GitHub Release object read');
    interrupted(signal);
    const name = assetName('object', request.chunk.sha256);
    const asset = await this.#findAsset(name, request.chunk.size, request.chunk.sha256, signal);
    if (asset == null) fail('GitHub Release object asset is unavailable');
    const response = await this.#download(asset, request.chunk.size, signal);
    return Object.freeze({ body: boundedBody(response.body, signal, request.chunk.size, 'GitHub Release object read') });
  }

  async ensureAuthority(raw = {}) {
    const request = authorityRequest(raw, 'publication');
    const signal = this.#signal(request.signal, 'GitHub Release authority publication');
    interrupted(signal);
    const name = assetName('authority', request.name);
    if (await this.#findAsset(name, request.size, request.sha256, signal) != null) return;
    await this.#uploadBytes(name, request.bytes, request.size, request.sha256, signal);
  }

  async readAuthority(raw = {}) {
    const request = authorityRequest(raw, 'read');
    const signal = this.#signal(request.signal, 'GitHub Release authority read');
    interrupted(signal);
    const name = assetName('authority', request.name);
    const asset = await this.#findAsset(name, request.size, request.sha256, signal);
    if (asset == null) fail('GitHub Release authority asset is unavailable');
    const response = await this.#download(asset, request.size, signal);
    const bytes = await readBounded(response, request.size, signal, 'GitHub Release authority read');
    if (sha256(bytes) !== request.sha256) fail('GitHub Release authority read bytes do not match authority');
    return bytes;
  }
}
