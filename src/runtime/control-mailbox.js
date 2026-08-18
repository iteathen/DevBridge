import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const SAFE_TURN = /^[A-Za-z0-9_.-]{1,80}$/u;
const MAX_RESULT_BYTES = 1_048_576;

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function assertRealDirectory(candidate, label) {
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError(`${label} must be a real control-owned directory`);
  return realpath(candidate);
}

function sameIdentity(expected, observed) {
  if (!expected || !observed) return false;
  // dev/ino are stable on supported Node filesystems, including NTFS. Keep
  // size/mode out of identity because the worker is expected to change size.
  return expected.dev === observed.dev && expected.ino === observed.ino;
}

function runKey(runId) {
  return createHash('sha256').update(String(runId), 'utf8').digest('hex').slice(0, 32);
}

function turnKey(turnId) {
  const value = String(turnId ?? 'turn-0');
  if (!SAFE_TURN.test(value) || value === '.' || value === '..') throw new PolicyError('mailbox turn identity is invalid');
  return value;
}

export class ControlMailbox {
  #root;

  constructor({ root }) {
    if (typeof root !== 'string' || !path.isAbsolute(path.resolve(root))) throw new TypeError('control mailbox root is required');
    this.#root = path.resolve(root);
  }

  get root() { return this.#root; }

  async #ensureRoot() {
    const parent = path.dirname(this.#root);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentReal = await assertRealDirectory(parent, 'control mailbox parent');
    if (await exists(this.#root)) {
      const rootReal = await assertRealDirectory(this.#root, 'control mailbox root');
      const relative = path.relative(parentReal, rootReal);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new PolicyError('control mailbox root resolves outside its owned parent');
      }
      return;
    }
    await mkdir(this.#root, { recursive: false, mode: 0o700 });
    await assertRealDirectory(this.#root, 'control mailbox root');
  }

  async #directory(parent, name, label) {
    const candidate = path.join(parent, name);
    if (await exists(candidate)) {
      await assertRealDirectory(candidate, label);
      return candidate;
    }
    await mkdir(candidate, { recursive: false, mode: 0o700 });
    await assertRealDirectory(candidate, label);
    return candidate;
  }

  async prepare({ runId, turnId }) {
    await this.#ensureRoot();
    const digest = runKey(runId);
    const runDir = await this.#directory(this.#root, digest, 'control mailbox run directory');
    const turn = turnKey(turnId);
    const turnDir = await this.#directory(runDir, turn, 'control mailbox turn directory');
    const nonce = randomUUID();
    const exchangeDir = path.join(turnDir, nonce);
    await mkdir(exchangeDir, { recursive: false, mode: 0o700 });
    await assertRealDirectory(exchangeDir, 'control mailbox exchange directory');

    const contextFile = path.join(exchangeDir, 'context.json');
    const resultFile = path.join(exchangeDir, 'result.json');
    await writeFile(resultFile, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const resultIdentity = await lstat(resultFile);
    if (resultIdentity.isSymbolicLink() || !resultIdentity.isFile()) throw new PolicyError('control mailbox result endpoint is not a regular file');

    const identity = {
      protocol: 'patch-poller/mailbox-v1',
      runDigest: digest,
      turnId: turn,
      nonce,
      result: { dev: resultIdentity.dev, ino: resultIdentity.ino },
    };
    await writeFile(path.join(exchangeDir, 'identity.json'), `${JSON.stringify(identity)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { runDigest: digest, turnId: turn, nonce, exchangeDir, contextFile, resultFile, resultIdentity: identity.result };
  }

  async writeContext(exchange, text) {
    const value = String(text);
    await writeFile(exchange.contextFile, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const info = await lstat(exchange.contextFile);
    if (info.isSymbolicLink() || !info.isFile()) throw new PolicyError('control mailbox context endpoint is not a regular file');
    return { dev: info.dev, ino: info.ino, size: info.size };
  }

  async consumeResult(exchange) {
    const before = await lstat(exchange.resultFile);
    if (before.isSymbolicLink() || !before.isFile()) throw new PolicyError('control mailbox result endpoint was substituted');
    if (!sameIdentity(exchange.resultIdentity, before)) throw new PolicyError('control mailbox result endpoint identity changed');

    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(exchange.resultFile, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameIdentity(exchange.resultIdentity, opened)) throw new PolicyError('control mailbox result endpoint changed during open');
      if (opened.size > MAX_RESULT_BYTES) throw new PolicyError('result file exceeds 1 MiB');
      if (opened.size === 0) return { text: null, size: 0 };
      const text = await handle.readFile({ encoding: 'utf8' });
      const after = await handle.stat();
      if (!sameIdentity(exchange.resultIdentity, after)) throw new PolicyError('control mailbox result endpoint identity changed during read');
      if (after.size > MAX_RESULT_BYTES) throw new PolicyError('result file exceeds 1 MiB');
      return { text, size: after.size };
    } finally {
      await handle.close();
    }
  }

  async readIdentity(exchange) {
    return JSON.parse(await readFile(path.join(exchange.exchangeDir, 'identity.json'), 'utf8'));
  }
}
