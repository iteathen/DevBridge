import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const EXACT_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 128 * 1024;

function fail(message) { throw new Error(message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function sameFile(left, right) {
  if (left.ino === 0n || right.ino === 0n || left.ino !== right.ino) return false;
  if (left.dev === 0n || right.dev === 0n) return process.platform === 'win32';
  return left.dev === right.dev;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

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

function readContainedRegularFile(root, relative, name, { minimum = 0, maximum = null } = {}) {
  const segments = normalizeRelativePath(relative);
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} parent is unsafe.`);
  }
  const candidate = path.join(root, ...segments);
  let descriptor;
  try {
    const before = lstatSync(candidate, { bigint: true });
    const lower = BigInt(minimum);
    const upper = maximum == null ? null : BigInt(maximum);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < lower
        || (upper != null && before.size > upper)) fail(`${name} must be a bounded regular file.`);
    if (!inside(root, realpathSync.native(candidate))) fail(`${name} escaped its component root.`);
    descriptor = openSync(candidate, 'r');
    const held = fstatSync(descriptor, { bigint: true });
    if (!held.isFile() || held.nlink !== 1n || held.size !== before.size || !sameFile(before, held)
        || held.size < lower || (upper != null && held.size > upper)) fail(`${name} changed while opening.`);
    const bytes = readFileSync(descriptor);
    const heldAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(candidate, { bigint: true });
    if (!heldAfter.isFile() || heldAfter.nlink !== 1n || heldAfter.size !== held.size || !sameFile(held, heldAfter)
        || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || after.size !== held.size
        || !sameFile(held, after) || BigInt(bytes.length) !== held.size
        || !inside(root, realpathSync.native(candidate))) fail(`${name} changed during observation.`);
    return bytes;
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
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
      const record = JSON.parse(readContainedRegularFile(canonicalRoot, manifestName, 'Component manifest', {
        minimum: 1,
        maximum: MAX_MANIFEST_BYTES,
      }).toString('utf8'));
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

  function exactChild(root, candidate, name) {
    const selectedRoot = path.resolve(root);
    const selected = path.resolve(candidate);
    if (path.dirname(selected) !== selectedRoot || selected === selectedRoot) fail(`${name} is outside its owned root.`);
    return selected;
  }

  function publish({ target, work, stagingRoot, preservation, preservationRoot, subject, endpoint = defaultEndpoint, obtainSource }) {
    if (typeof obtainSource !== 'function') throw new TypeError('obtainSource must be a function');
    const selectedWork = exactChild(stagingRoot, work, 'Component work path');
    const selectedPreservation = exactChild(preservationRoot, preservation, 'Component preservation path');
    if (verify(target, subject, endpoint)) {
      if (existsSync(selectedWork)) fail('Component work path remains from an incomplete operation.');
      return Object.freeze({ published: false, preserved: false, workAbsent: true });
    }
    let preserved = false;
    if (existsSync(target)) {
      if (existsSync(selectedPreservation)) fail('Component preservation path is already occupied.');
      renameSync(target, selectedPreservation);
      if (existsSync(target) || !existsSync(selectedPreservation)) fail('Component preservation did not reconcile exactly.');
      preserved = true;
    }
    if (existsSync(selectedWork)) fail('Component work path is already occupied.');
    let workCreated = false;
    try {
      mkdirSync(selectedWork, { mode: 0o700 });
      workCreated = true;
      const component = path.join(selectedWork, 'component');
      const source = obtainSource(path.join(selectedWork, 'source'));
      if (typeof source !== 'string' || !path.isAbsolute(source)) fail('Source materialization returned an invalid root.');
      copy(source, component);
      writeFileSync(path.join(component, manifestName), `${JSON.stringify(manifest(component, subject, endpoint), null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      if (!verify(component, subject, endpoint)) fail('Staged component failed self-verification.');
      try {
        renameSync(component, target);
      } catch (error) {
        if (!existsSync(target) || !verify(target, subject, endpoint)) throw error;
      }
    } finally {
      if (workCreated) rmSync(selectedWork, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
    if (!verify(target, subject, endpoint)) fail('Installed component failed verification.');
    if (existsSync(selectedWork)) fail('Component work path remains after publication.');
    return Object.freeze({ published: true, preserved, workAbsent: true });
  }

  return Object.freeze({ publish, verify });
}
