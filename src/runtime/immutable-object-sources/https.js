import {
  immutableObjectSourceAbort,
  normalizeImmutableObjectSourceRequest,
} from './request.js';

const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

function normalizeBaseUrl(raw) {
  let value;
  try { value = new URL(raw); } catch { throw new TypeError('immutable object HTTPS base URL is invalid'); }
  if (value.protocol !== 'https:' || value.username || value.password || value.port || value.search || value.hash) {
    throw new TypeError('immutable object HTTPS base URL is not approved HTTPS');
  }
  if (!value.pathname.endsWith('/')) throw new TypeError('immutable object HTTPS base URL requires a trailing slash');
  return value;
}

function header(response, name) {
  if (!response?.headers || typeof response.headers.get !== 'function') throw new Error('immutable object HTTPS response headers are invalid');
  return response.headers.get(name);
}

function declaredLength(response) {
  const raw = header(response, 'content-length');
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(raw.trim())) {
    throw new Error('immutable object HTTPS response content length is missing or invalid');
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) throw new Error('immutable object HTTPS response content length is invalid');
  return value;
}

function abortable(work, signal) {
  immutableObjectSourceAbort(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      try { immutableObjectSourceAbort(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(work).then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
}

async function* boundedBody(body, signal) {
  const iterator = body[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      const result = await abortable(() => iterator.next(), signal);
      if (!result || typeof result.done !== 'boolean') throw new Error('immutable object HTTPS body iterator returned an invalid result');
      if (result.done) { complete = true; return; }
      immutableObjectSourceAbort(signal);
      yield result.value;
    }
  } finally {
    if (!complete && typeof iterator.return === 'function') Promise.resolve().then(() => iterator.return()).catch(() => {});
  }
}

export class HttpsImmutableObjectSource {
  #baseUrl;
  #maxDurationMs;
  #fetch;
  #timeoutSignal;

  constructor({ baseUrl, maxDurationMs, fetchImpl = globalThis.fetch, timeoutSignal = AbortSignal.timeout } = {}) {
    if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1_000 || maxDurationMs > MAX_DURATION_MS) {
      throw new TypeError('immutable object HTTPS duration is invalid');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('immutable object HTTPS fetch implementation is invalid');
    if (typeof timeoutSignal !== 'function') throw new TypeError('immutable object HTTPS timeout signal factory is invalid');
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#maxDurationMs = maxDurationMs;
    this.#fetch = fetchImpl;
    this.#timeoutSignal = timeoutSignal;
  }

  async fetch(raw) {
    const request = normalizeImmutableObjectSourceRequest(raw);
    immutableObjectSourceAbort(request.signal);
    const durationSignal = this.#timeoutSignal(this.#maxDurationMs);
    if (!durationSignal || typeof durationSignal.aborted !== 'boolean'
        || typeof durationSignal.addEventListener !== 'function'
        || typeof durationSignal.removeEventListener !== 'function') {
      throw new TypeError('immutable object HTTPS timeout signal is invalid');
    }
    const signal = request.signal == null ? durationSignal : AbortSignal.any([request.signal, durationSignal]);
    immutableObjectSourceAbort(signal);
    const url = new URL(request.chunk.sha256, this.#baseUrl);
    const response = await abortable(() => this.#fetch(url, {
      redirect: 'error',
      signal,
      headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity' },
    }), signal);
    immutableObjectSourceAbort(signal);
    if (!response || !Number.isInteger(response.status)) throw new Error('immutable object HTTPS response is invalid');
    if (response.status !== 200) throw new Error(`immutable object HTTPS source failed with HTTP ${response.status}`);
    if (response.redirected === true) throw new Error('immutable object HTTPS source returned a redirected response');
    if (header(response, 'content-range') != null) throw new Error('immutable object HTTPS source returned an unexpected range');
    const encoding = header(response, 'content-encoding');
    if (encoding != null && encoding.trim().toLowerCase() !== 'identity') {
      throw new Error('immutable object HTTPS source returned a transformed encoding');
    }
    if (declaredLength(response) !== request.chunk.size) {
      throw new Error('immutable object HTTPS declared byte count does not match authority');
    }
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
      throw new Error('immutable object HTTPS response body is invalid');
    }
    return Object.freeze({ body: boundedBody(response.body, signal) });
  }
}
