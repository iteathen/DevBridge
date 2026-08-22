import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeRunnerSubject, sameRunnerSubject } from './permanent-entry.mjs';

export const STABLE_RUNNER_STATE_PROTOCOL = 'devbridge/entry-stable-state-v1';

const MAX_STATE_BYTES = 32 * 1024;
const DIGEST = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]+$/u;

function fail(message) { throw new Error(message); }

function boundedText(value, name, limit = 256) {
  const text = String(value ?? '');
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) fail(`${name} is invalid`);
  return text;
}

function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('stable runner record is invalid');
  const allowed = new Set(['subject', 'mode', 'sequence', 'manifestSha256', 'keyId', 'acceptedAt']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`stable runner record.${key} is unsupported`);
  const mode = input.mode;
  if (!['development', 'production'].includes(mode)) fail('stable runner record mode is invalid');
  let sequence = null;
  let manifestSha256 = null;
  let keyId = null;
  if (mode === 'production') {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) fail('stable production runner sequence is invalid');
    sequence = input.sequence;
    manifestSha256 = String(input.manifestSha256 ?? '').toLowerCase();
    if (!DIGEST.test(manifestSha256)) fail('stable production manifest digest is invalid');
    keyId = boundedText(input.keyId, 'stable production key identity', 128);
    if (!KEY_ID.test(keyId)) fail('stable production key identity is invalid');
  } else if (input.sequence != null || input.manifestSha256 != null || input.keyId != null) {
    fail('stable development runner record cannot carry production evidence');
  }
  const acceptedAt = boundedText(input.acceptedAt, 'stable runner accepted time', 64);
  if (!Number.isFinite(Date.parse(acceptedAt))) fail('stable runner accepted time is invalid');
  return Object.freeze({
    subject: normalizeRunnerSubject(input.subject),
    mode,
    sequence,
    manifestSha256,
    keyId,
    acceptedAt,
  });
}

function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('stable runner state is invalid');
  const allowed = new Set(['protocol', 'revision', 'current', 'previous']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`stable runner state.${key} is unsupported`);
  if (input.protocol !== STABLE_RUNNER_STATE_PROTOCOL) fail('stable runner state protocol is unsupported');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail('stable runner state revision is invalid');
  return Object.freeze({
    protocol: STABLE_RUNNER_STATE_PROTOCOL,
    revision: input.revision,
    current: normalizeRecord(input.current),
    previous: input.previous == null ? null : normalizeRecord(input.previous),
  });
}

function sameRecord(left, right) {
  if (left == null || right == null) return left === right;
  return sameRunnerSubject(left.subject, right.subject) &&
    left.mode === right.mode &&
    left.sequence === right.sequence &&
    left.manifestSha256 === right.manifestSha256 &&
    left.keyId === right.keyId &&
    left.acceptedAt === right.acceptedAt;
}

function sameState(left, right) {
  return left.protocol === right.protocol && left.revision === right.revision &&
    sameRecord(left.current, right.current) && sameRecord(left.previous, right.previous);
}

async function ensureRealDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('stable runner state root must be a real directory');
  return realpath(directory);
}

async function readStateFile(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_STATE_BYTES) {
    fail('stable runner state file is invalid');
  }
  const bytes = await readFile(file);
  if (bytes.length < 1 || bytes.length > MAX_STATE_BYTES) fail('stable runner state file is invalid');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { fail('stable runner state is not valid JSON'); }
  return normalizeState(parsed);
}

export class StableRunnerState {
  #root;

  constructor({ stateRoot } = {}) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
      throw new TypeError('stable runner stateRoot must be an absolute local path');
    }
    this.#root = path.resolve(stateRoot);
  }

  async read() {
    const root = await ensureRealDirectory(this.#root);
    return readStateFile(path.join(root, 'stable-state.json'));
  }

  async accept(input) {
    const record = normalizeRecord(input);
    const root = await ensureRealDirectory(this.#root);
    const file = path.join(root, 'stable-state.json');
    const before = await readStateFile(file);
    if (before && sameRunnerSubject(before.current.subject, record.subject) &&
        before.current.mode === record.mode && before.current.sequence === record.sequence &&
        before.current.manifestSha256 === record.manifestSha256 && before.current.keyId === record.keyId) {
      return before;
    }

    const next = normalizeState({
      protocol: STABLE_RUNNER_STATE_PROTOCOL,
      revision: (before?.revision ?? 0) + 1,
      current: record,
      previous: before?.current ?? null,
    });
    const temporary = path.join(root, `.stable-state.${randomUUID()}.tmp`);
    let handle = null;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, file);
      const observed = await readStateFile(file);
      if (!observed || !sameState(next, observed)) fail('stable runner state publication became ambiguous');
      return observed;
    } finally {
      if (handle) { try { await handle.close(); } catch {} }
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async fallback(failedSubject) {
    const failed = normalizeRunnerSubject(failedSubject);
    const state = await this.read();
    if (!state) return null;
    if (!sameRunnerSubject(state.current.subject, failed)) return state.current.subject;
    return state.previous?.subject ?? null;
  }

  async status() {
    const state = await this.read();
    if (!state) return Object.freeze({ configured: false, revision: 0, current: null, previous: null });
    const project = (record) => record == null ? null : Object.freeze({
      subject: record.subject,
      mode: record.mode,
      sequence: record.sequence,
      manifestSha256: record.manifestSha256,
      keyId: record.keyId,
      acceptedAt: record.acceptedAt,
    });
    return Object.freeze({
      configured: true,
      revision: state.revision,
      current: project(state.current),
      previous: project(state.previous),
    });
  }
}
