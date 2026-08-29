const MAX_SUBJECT_BYTES = 64 * 1024;
const MAX_STAGE_BYTES = 512 * 1024;
const MAX_HELPER_BYTES = 128 * 1024;

function fail(message) { throw new Error(message); }

async function readBoundedResponse(response, name, maxBytes) {
  if (!response || response.ok !== true || response.status !== 200) fail(`${name} request failed with status ${response?.status ?? 'unknown'}.`);
  const declared = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isInteger(declared) && declared > maxBytes) fail(`${name} response is too large.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > maxBytes) fail(`${name} response size is invalid.`);
  return bytes;
}

export function createSourceChannel({
  apiBase,
  rawBase,
  userAgent,
  stagePath,
  helperPath,
  normalizeSelector,
  isExactHead,
}) {
  for (const [name, value] of Object.entries({ apiBase, rawBase, userAgent, stagePath, helperPath })) {
    if (typeof value !== 'string' || value.length < 1) throw new TypeError(`${name} must be non-empty text`);
  }
  if (typeof normalizeSelector !== 'function' || typeof isExactHead !== 'function') throw new TypeError('source validators must be functions');

  async function request(url, { fetcher = globalThis.fetch, name, maxBytes, accept }) {
    if (typeof fetcher !== 'function') fail('Node fetch support is unavailable.');
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      headers: Object.freeze({ Accept: accept, 'User-Agent': userAgent }),
    });
    return readBoundedResponse(response, name, maxBytes);
  }

  function rawUrl(head, relative) {
    const encoded = String(relative).split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return `${rawBase}${head}/${encoded}`;
  }

  async function resolve(selector, { fetcher = globalThis.fetch } = {}) {
    const normalized = normalizeSelector(selector?.value ?? selector);
    if (normalized.kind === 'exact') return normalized.value;
    const encodedRef = normalized.value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    const bytes = await request(`${apiBase}${encodedRef}`, {
      fetcher,
      name: 'Subject',
      maxBytes: MAX_SUBJECT_BYTES,
      accept: 'application/vnd.github+json',
    });
    let payload;
    try { payload = JSON.parse(bytes.toString('utf8')); }
    catch { fail('Subject response is invalid.'); }
    const expectedRef = `refs/heads/${normalized.value}`;
    const head = String(payload?.object?.sha ?? '').toLowerCase();
    if (payload?.ref !== expectedRef || !isExactHead(head)) fail('Subject response is invalid.');
    return head;
  }

  async function fetchStage(head, { fetcher = globalThis.fetch } = {}) {
    const exact = String(head ?? '').toLowerCase();
    if (!isExactHead(exact)) fail('Stage requires an exact subject.');
    return request(rawUrl(exact, stagePath), {
      fetcher,
      name: 'Stage',
      maxBytes: MAX_STAGE_BYTES,
      accept: 'application/octet-stream',
    });
  }

  async function fetchHelper(head, { fetcher = globalThis.fetch } = {}) {
    const exact = String(head ?? '').toLowerCase();
    if (!isExactHead(exact)) fail('Helper requires an exact subject.');
    return request(rawUrl(exact, helperPath), {
      fetcher,
      name: 'Source-acquisition stage',
      maxBytes: MAX_HELPER_BYTES,
      accept: 'application/octet-stream',
    });
  }

  return Object.freeze({ fetchHelper, fetchStage, resolve });
}
