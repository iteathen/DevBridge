import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const EXACT_REVISION = /^[0-9a-f]{40}$/u;
const MAX_PATHS = 64;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'DevBridge-exact-source-acquisition/1';

function fail(message) { throw new Error(message); }

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 ||
      value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.includes(':')) {
    fail('Exact source path is invalid.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('Exact source path is invalid.');
  }
  return Object.freeze({ relative: segments.join('/'), segments: Object.freeze(segments) });
}

function normalizePaths(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_PATHS) {
    fail('Exact source file set is invalid.');
  }
  const result = paths.map(normalizeRelativePath);
  const unique = new Set(result.map((entry) => entry.relative));
  if (unique.size !== result.length) fail('Exact source file set contains duplicate paths.');
  return Object.freeze(result);
}

function normalizeSourceBase(value) {
  let url;
  try { url = new URL(String(value)); }
  catch { fail('Exact source base URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail('Exact source base URL is invalid.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function readBoundedResponse(response, relative, maxBytes) {
  if (!response || response.ok !== true || response.status !== 200) {
    fail(`Exact source request failed for ${relative} with status ${response?.status ?? 'unknown'}.`);
  }
  const declared = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isInteger(declared) && declared > maxBytes) {
    fail(`Exact source response is too large for ${relative}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > maxBytes) {
    fail(`Exact source response size is invalid for ${relative}.`);
  }
  return bytes;
}

function writeContainedFile(root, entry, bytes) {
  let parent = root;
  for (const segment of entry.segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
  }
  writeFileSync(path.join(root, ...entry.segments), bytes, {
    mode: 0o600,
    flag: 'wx',
    flush: true,
  });
}

export async function materializeExactSource({
  revision,
  paths,
  destination,
  sourceBase,
  fetcher = globalThis.fetch,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  userAgent = DEFAULT_USER_AGENT,
}) {
  const exact = String(revision ?? '').toLowerCase();
  if (!EXACT_REVISION.test(exact)) fail('Exact source acquisition requires one exact revision.');
  if (typeof fetcher !== 'function') fail('Node fetch support is unavailable.');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxFileBytes) {
    fail('Exact source byte bounds are invalid.');
  }
  if (typeof userAgent !== 'string' || userAgent.length < 1 || userAgent.length > 256) {
    fail('Exact source user agent is invalid.');
  }

  const files = normalizePaths(paths);
  const base = normalizeSourceBase(sourceBase);
  const root = path.resolve(String(destination ?? ''));
  if (existsSync(root)) fail('Exact source destination must not already exist.');
  mkdirSync(root, { mode: 0o700 });

  let totalBytes = 0;
  try {
    for (const entry of files) {
      const encodedPath = entry.segments.map((segment) => encodeURIComponent(segment)).join('/');
      const url = new URL(`${exact}/${encodedPath}`, base);
      const response = await fetcher(url.href, {
        method: 'GET',
        redirect: 'error',
        headers: Object.freeze({
          Accept: 'application/octet-stream',
          'User-Agent': userAgent,
        }),
      });
      const bytes = await readBoundedResponse(response, entry.relative, maxFileBytes);
      totalBytes += bytes.length;
      if (totalBytes > maxTotalBytes) fail('Exact source file set exceeds its total byte bound.');
      writeContainedFile(root, entry, bytes);
    }

    return Object.freeze({
      revision: exact,
      root: realpathSync.native(root),
      files: Object.freeze(files.map((entry) => entry.relative)),
      bytes: totalBytes,
    });
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); } catch {}
    throw error;
  }
}
