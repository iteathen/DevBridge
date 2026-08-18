import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const SAFE_ID = /^[A-Za-z0-9_.-]{1,120}$/u;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function safeId(value, label) {
  const normalized = String(value);
  if (!SAFE_ID.test(normalized) || normalized === '.' || normalized === '..') throw new PolicyError(`${label} is not safe for a control mailbox`);
  return normalized;
}

async function assertRealDirectory(candidate, label) {
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError(`${label} must be a real directory`);
  return realpath(candidate);
}

async function ensureOwnedRoot(root) {
  const resolved = path.resolve(root);
  const parent = path.dirname(resolved);
  if (!(await exists(parent))) await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertRealDirectory(parent, 'control mailbox parent');
  if (!(await exists(resolved))) await mkdir(resolved, { recursive: false, mode: 0o700 });
  await assertRealDirectory(resolved, 'control mailbox root');
  return resolved;
}

async function readRegularNoFollow(filePath, maxBytes) {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new PolicyError('worker result must be a regular non-link file');
  if (before.size > maxBytes) throw new PolicyError('worker result exceeds the bounded mailbox result size');
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const observed = await handle.stat();
    if (!observed.isFile() || observed.size > maxBytes) throw new PolicyError('worker result changed type or exceeded its bound');
    if (observed.dev !== before.dev || observed.ino !== before.ino) throw new PolicyError('worker result identity changed before read');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export class ControlMailboxStore {
  #root;

  constructor({ root }) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new PolicyError('control mailbox root must be an absolute local path');
    this.#root = path.resolve(root);
  }

  get root() { return this.#root; }

  async create({ runId, turn }) {
    const root = await ensureOwnedRoot(this.#root);
    const safeRunId = safeId(runId, 'runId');
    if (!Number.isInteger(turn) || turn < 1 || turn > 1_000_000) throw new PolicyError('mailbox turn must be a positive bounded integer');
    const nonce = randomBytes(16).toString('hex');
    const mailboxId = `${safeRunId}.turn-${turn}.${nonce}`;
    const directory = path.join(root, mailboxId);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await assertRealDirectory(directory, 'control mailbox directory');
    const inputDir = path.join(directory, 'input');
    const outputDir = path.join(directory, 'output');
    await mkdir(inputDir, { recursive: false, mode: 0o700 });
    await mkdir(outputDir, { recursive: false, mode: 0o700 });
    return {
      mailboxId,
      runId: safeRunId,
      turn,
      directory,
      inputDir,
      outputDir,
      contextFile: path.join(inputDir, 'context.json'),
      resultFile: path.join(outputDir, 'result.json'),
    };
  }

  async writeContext(mailbox, context) {
    await assertRealDirectory(mailbox.inputDir, 'control mailbox input directory');
    if (await exists(mailbox.contextFile)) throw new PolicyError('control mailbox context file already exists');
    const payload = `${JSON.stringify(context, null, 2)}\n`;
    await writeFile(mailbox.contextFile, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const info = await lstat(mailbox.contextFile);
    if (info.isSymbolicLink() || !info.isFile()) throw new PolicyError('control mailbox context creation was not stable');
    return mailbox.contextFile;
  }

  async readResult(mailbox, { maxBytes = MAX_RESULT_BYTES } = {}) {
    if (!mailbox || !String(mailbox.directory).startsWith(`${this.#root}${path.sep}`)) throw new PolicyError('mailbox does not belong to this control store');
    await assertRealDirectory(mailbox.outputDir, 'control mailbox output directory');
    if (!(await exists(mailbox.resultFile))) return null;
    return readRegularNoFollow(mailbox.resultFile, maxBytes);
  }

  async remove(mailbox) {
    if (!mailbox) return;
    const resolved = path.resolve(mailbox.directory);
    const relative = path.relative(this.#root, resolved);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new PolicyError('refusing to remove a mailbox outside the control root');
    if (await exists(resolved)) {
      const info = await lstat(resolved);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError('control mailbox was replaced before cleanup');
      await rm(resolved, { recursive: true, force: true });
    }
  }
}
