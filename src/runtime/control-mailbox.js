import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const SAFE_TURN = /^[A-Za-z0-9_.-]{1,80}$/u;
const MAX_RESULT_BYTES = 1_048_576;
const MAX_RESULT_BYTES_BIGINT = BigInt(MAX_RESULT_BYTES);

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function assertRealDirectory(candidate, label) {
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError(`${label} must be a real control-owned directory`);
  return realpath(candidate);
}

function fileIdentity(stats) {
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function sameIdentity(expected, observed) {
  if (!expected || !observed) return false;
  const identity = fileIdentity(observed);
  return expected.dev === identity.dev && expected.ino === identity.ino;
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
    const resultHandle = await open(resultFile, 'wx+', 0o600);
    let resultStats;
    try {
      resultStats = await lstat(resultFile, { bigint: true });
      if (resultStats.isSymbolicLink() || !resultStats.isFile()) throw new PolicyError('control mailbox result endpoint is not a regular file');
    } catch (error) {
      await resultHandle.close();
      throw error;
    }

    const identity = {
      protocol: 'patch-poller/mailbox-v1',
      runDigest: digest,
      turnId: turn,
      nonce,
      result: fileIdentity(resultStats),
    };
    await writeFile(path.join(exchangeDir, 'identity.json'), `${JSON.stringify(identity)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return {
      runDigest: digest,
      turnId: turn,
      nonce,
      exchangeDir,
      contextFile,
      resultFile,
      resultIdentity: identity.result,
      resultHandle,
    };
  }

  async writeContext(exchange, text) {
    const value = String(text);
    await writeFile(exchange.contextFile, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const info = await lstat(exchange.contextFile);
    if (info.isSymbolicLink() || !info.isFile()) throw new PolicyError('control mailbox context endpoint is not a regular file');
    return { dev: info.dev, ino: info.ino, size: info.size };
  }

  async consumeResult(exchange) {
    const handle = exchange?.resultHandle;
    if (!handle || typeof handle.stat !== 'function') throw new PolicyError('control mailbox result handle is unavailable');
    try {
      const before = await lstat(exchange.resultFile, { bigint: true });
      if (before.isSymbolicLink() || !before.isFile()) throw new PolicyError('control mailbox result endpoint was substituted');
      if (!sameIdentity(exchange.resultIdentity, before)) throw new PolicyError('control mailbox result endpoint identity changed');

      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()) throw new PolicyError('control mailbox retained result handle is not a regular file');
      if (opened.size > MAX_RESULT_BYTES_BIGINT) throw new PolicyError('result file exceeds 1 MiB');
      if (opened.size === 0n) return { text: null, size: 0 };

      const text = await handle.readFile({ encoding: 'utf8' });
      const afterHandle = await handle.stat({ bigint: true });
      if (afterHandle.size > MAX_RESULT_BYTES_BIGINT) throw new PolicyError('result file exceeds 1 MiB');
      const afterPath = await lstat(exchange.resultFile, { bigint: true });
      if (afterPath.isSymbolicLink() || !afterPath.isFile() || !sameIdentity(exchange.resultIdentity, afterPath)) {
        throw new PolicyError('control mailbox result endpoint changed during read');
      }
      return { text, size: Number(afterHandle.size) };
    } finally {
      await handle.close();
      exchange.resultHandle = null;
    }
  }

  async readIdentity(exchange) {
    return JSON.parse(await readFile(path.join(exchange.exchangeDir, 'identity.json'), 'utf8'));
  }
}
