import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MAX_RECORD_BYTES = 4096;

function fail(message) { throw new Error(message); }

function ensureRealDirectory(candidate, name, { create = false, recursive = false } = {}) {
  if (create && !existsSync(candidate)) mkdirSync(candidate, { recursive, mode: 0o700 });
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory.`);
  return realpathSync.native(candidate);
}

function sameSelector(left, right) {
  return left?.kind === right?.kind && left?.value === right?.value;
}

export function createSelectionState({ protocol, source, normalizeSelector, isExactHead, directoryName, recordName }) {
  if (typeof protocol !== 'string' || protocol.length < 1) throw new TypeError('protocol must be non-empty text');
  if (typeof source !== 'string' || source.length < 1) throw new TypeError('source must be non-empty text');
  if (typeof normalizeSelector !== 'function' || typeof isExactHead !== 'function') throw new TypeError('selection validators must be functions');
  for (const [name, value] of Object.entries({ directoryName, recordName })) {
    if (typeof value !== 'string' || path.basename(value) !== value) throw new TypeError(`${name} must be one safe name`);
  }

  function pathFor(home) {
    return path.join(path.resolve(home), directoryName, recordName);
  }

  function roots(requestedHome) {
    const home = ensureRealDirectory(requestedHome, 'State home', { create: true, recursive: true });
    const candidate = path.join(home, directoryName);
    const bootstrap = ensureRealDirectory(candidate, 'State directory', { create: true });
    return Object.freeze({ home, bootstrap });
  }

  function validate(record) {
    if (record?.protocol !== protocol || record?.source !== source || !isExactHead(record?.head)) fail('Selection record is invalid.');
    const selector = normalizeSelector(record?.selector?.value);
    if (selector.kind !== record?.selector?.kind || selector.value !== record?.selector?.value) fail('Selection record is invalid.');
    return Object.freeze({ protocol, source, selector, head: String(record.head).toLowerCase() });
  }

  function read(home) {
    const selectionPath = pathFor(home);
    if (!existsSync(selectionPath)) return null;
    const info = lstatSync(selectionPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_RECORD_BYTES) fail('Selection record is invalid.');
    try { return validate(JSON.parse(readFileSync(selectionPath, 'utf8'))); }
    catch (error) {
      if (error?.message === 'Selection record is invalid.') throw error;
      fail('Selection record is invalid.');
    }
  }

  async function resolve(options, { resolveSubject }) {
    if (typeof resolveSubject !== 'function') throw new TypeError('resolveSubject must be a function');
    const location = roots(path.resolve(options.home));
    const existing = read(location.home);
    if (existing) {
      if (!sameSelector(existing.selector, options.selector)) {
        fail(`Recovery is already bound to ${existing.selector.value} at ${existing.head}; resume that selection before starting another subject.`);
      }
      return Object.freeze({ ...existing, home: location.home, resumed: true });
    }

    const head = await resolveSubject(options.selector);
    const record = Object.freeze({ protocol, source, selector: options.selector, head });
    const temporary = path.join(location.bootstrap, `.selection-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
    const selectionPath = path.join(location.bootstrap, recordName);
    try {
      try { linkSync(temporary, selectionPath); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const winner = read(location.home);
        if (!winner || !sameSelector(winner.selector, options.selector)) fail('A different selection became authoritative concurrently.');
        return Object.freeze({ ...winner, home: location.home, resumed: true });
      }
      return Object.freeze({ ...record, home: location.home, resumed: false });
    } finally {
      try { unlinkSync(temporary); } catch {}
    }
  }

  function clear(subject) {
    const current = read(subject.home);
    if (!current) return;
    if (current.head !== subject.head || !sameSelector(current.selector, subject.selector)) fail('Selection changed before commit reconciliation.');
    unlinkSync(pathFor(subject.home));
  }

  return Object.freeze({ clear, pathFor, read, resolve });
}
