import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function logicalIdentity(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || value.startsWith('/')
      || value.includes('\\') || value.includes('\0') || value.includes(':')) {
    throw new TypeError(`${name} is invalid`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'
      || /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function relativeSpecifier(value) {
  if (typeof value !== 'string' || (!value.startsWith('./') && !value.startsWith('../'))
      || value.includes('\\') || value.includes('\0') || value.includes('?') || value.includes('#')) {
    throw new TypeError('standalone source edge specifier is invalid');
  }
  return value;
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function createStandaloneSourceLoader({ root } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) {
    throw new TypeError('standalone source root must be an absolute local path');
  }
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('standalone source root must be a real directory');
  const selectedRoot = realpathSync.native(root);

  function read(identityValue) {
    const identity = logicalIdentity(identityValue, 'standalone source identity');
    const segments = identity.split('/');
    let current = selectedRoot;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
        fail('standalone source edge has an unsupported filesystem shape');
      }
    }
    const actual = realpathSync.native(current);
    if (!isWithin(selectedRoot, actual) || comparable(actual) !== comparable(current)) {
      fail('standalone source edge escaped or used filesystem indirection');
    }
    return Object.freeze({ identity, bytes: readFileSync(actual) });
  }

  function load(raw) {
    const value = exactObject(raw, new Set(['importer', 'specifier']), 'standalone source edge');
    const importer = logicalIdentity(value.importer, 'standalone source edge.importer');
    const specifier = relativeSpecifier(value.specifier);
    const identity = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    if (identity === '..' || identity.startsWith('../') || path.posix.isAbsolute(identity)) {
      fail('standalone source edge escaped its root');
    }
    return read(identity);
  }

  return Object.freeze({ read, load });
}
