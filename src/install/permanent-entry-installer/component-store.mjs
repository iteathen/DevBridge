import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const EXACT_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 128 * 1024;

function fail(message) { throw new Error(message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function normalizedEndpoint(value) {
  return String(value ?? '').trim().replace(/\/$/u, '').replace(/\.git$/u, '').toLowerCase();
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 ||
      value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.includes(':')) {
    fail('Component manifest contains an unsafe path.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('Component manifest contains an unsafe path.');
  }
  return segments;
}

function readContainedRegularFile(root, relative, name) {
  const segments = normalizeRelativePath(relative);
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} parent is unsafe.`);
  }
  const candidate = path.join(root, ...segments);
  const info = lstatSync(candidate);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${name} must be a regular file.`);
  const actual = realpathSync.native(candidate);
  const relativeActual = path.relative(root, actual);
  if (relativeActual.startsWith('..') || path.isAbsolute(relativeActual)) fail(`${name} escaped its component root.`);
  return readFileSync(actual);
}

function walkFiles(root, current = root, result = []) {
  for (const name of readdirSync(current).sort()) {
    const candidate = path.join(current, name);
    const info = lstatSync(candidate);
    if (info.isSymbolicLink()) fail('Component contains a symbolic link.');
    if (info.isDirectory()) walkFiles(root, candidate, result);
    else if (info.isFile()) result.push(path.relative(root, candidate).split(path.sep).join('/'));
    else fail('Component contains an unsupported filesystem object.');
  }
  return result;
}

export function createComponentStore({ protocol, files, defaultEndpoint, manifestName, endpointField }) {
  if (typeof protocol !== 'string' || protocol.length < 1) throw new TypeError('protocol must be non-empty text');
  if (!Array.isArray(files) || files.length < 1 || files.some((value) => typeof value !== 'string')) {
    throw new TypeError('files must be a non-empty text array');
  }
  if (typeof defaultEndpoint !== 'string' || defaultEndpoint.length < 1) throw new TypeError('defaultEndpoint must be non-empty text');
  if (typeof manifestName !== 'string' || path.basename(manifestName) !== manifestName) throw new TypeError('manifestName must be one safe name');
  if (typeof endpointField !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(endpointField)) throw new TypeError('endpointField must be one safe field name');
  const componentFiles = Object.freeze([...files]);

  function manifest(root, head, endpoint) {
    return Object.freeze({
      protocol,
      head,
      [endpointField]: normalizedEndpoint(endpoint),
      files: componentFiles.map((relative) => {
        const bytes = readContainedRegularFile(root, relative, `Component ${relative}`);
        return Object.freeze({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
      }),
    });
  }

  function verify(root, expectedHead, endpoint = defaultEndpoint) {
    try {
      const info = lstatSync(root);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const canonicalRoot = realpathSync.native(root);
      const manifestPath = path.join(canonicalRoot, manifestName);
      const manifestInfo = lstatSync(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() ||
          manifestInfo.size < 1 || manifestInfo.size > MAX_MANIFEST_BYTES) return false;

      const record = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (record?.protocol !== protocol || record.head !== expectedHead ||
          record[endpointField] !== normalizedEndpoint(endpoint) ||
          !Array.isArray(record.files) || record.files.length !== componentFiles.length) return false;

      const expected = new Set(componentFiles);
      const listed = new Set();
      for (const item of record.files) {
        const segments = normalizeRelativePath(item?.path);
        const relative = segments.join('/');
        if (!expected.has(relative) || listed.has(relative) ||
            !Number.isSafeInteger(item?.bytes) || item.bytes < 0 ||
            !EXACT_DIGEST.test(String(item?.sha256 ?? '').toLowerCase())) return false;
        listed.add(relative);
        const bytes = readContainedRegularFile(canonicalRoot, relative, `Component ${relative}`);
        if (bytes.length !== item.bytes || digest(bytes) !== String(item.sha256).toLowerCase()) return false;
      }
      if (listed.size !== expected.size || [...expected].some((relative) => !listed.has(relative))) return false;

      const actual = walkFiles(canonicalRoot)
        .filter((relative) => relative !== manifestName)
        .sort();
      const expectedSorted = [...expected].sort();
      return actual.length === expectedSorted.length &&
        actual.every((relative, index) => relative === expectedSorted[index]);
    } catch {
      return false;
    }
  }

  function copy(source, destination) {
    mkdirSync(destination, { mode: 0o700 });
    for (const relative of componentFiles) {
      const bytes = readContainedRegularFile(source, relative, `Source ${relative}`);
      const segments = normalizeRelativePath(relative);
      let parent = destination;
      for (const segment of segments.slice(0, -1)) {
        parent = path.join(parent, segment);
        if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
        else {
          const info = lstatSync(parent);
          if (!info.isDirectory() || info.isSymbolicLink()) fail(`Destination for ${relative} is unsafe.`);
        }
      }
      writeFileSync(path.join(destination, ...segments), bytes, { mode: 0o600, flag: 'wx' });
    }
  }

  function quarantine(target, quarantineRoot, head) {
    if (!existsSync(target)) return null;
    const destination = path.join(quarantineRoot, `${head.slice(0, 12)}-${randomUUID()}`);
    renameSync(target, destination);
    return destination;
  }

  function publish({ target, stagingRoot, quarantineRoot, head, endpoint = defaultEndpoint, obtainSource }) {
    if (typeof obtainSource !== 'function') throw new TypeError('obtainSource must be a function');
    if (verify(target, head, endpoint)) return;
    quarantine(target, quarantineRoot, head);
    const work = mkdtempSync(path.join(stagingRoot, `${head.slice(0, 12)}-`));
    try {
      const component = path.join(work, 'component');
      const source = obtainSource(path.join(work, 'source'));
      if (typeof source !== 'string' || !path.isAbsolute(source)) fail('Source materialization returned an invalid root.');
      copy(source, component);
      writeFileSync(path.join(component, manifestName), `${JSON.stringify(manifest(component, head, endpoint), null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      if (!verify(component, head, endpoint)) fail('Staged component failed self-verification.');
      try {
        renameSync(component, target);
      } catch (error) {
        if (!existsSync(target) || !verify(target, head, endpoint)) throw error;
      }
    } finally {
      try { rmSync(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); } catch {}
    }
    if (!verify(target, head, endpoint)) fail('Installed component failed verification.');
  }

  return Object.freeze({ publish, verify });
}
