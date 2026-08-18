import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/u;
const MAX_RESULT_BYTES = 1024 * 1024;

function safeId(value, name) {
  const text = String(value);
  if (!SAFE_ID.test(text) || text === '.' || text === '..') throw new PolicyError(`${name} is not a safe exchange identifier`);
  return text;
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function identity(info) {
  return {
    dev: typeof info.dev === 'bigint' ? info.dev.toString() : String(info.dev ?? ''),
    ino: typeof info.ino === 'bigint' ? info.ino.toString() : String(info.ino ?? ''),
    birthtimeMs: Number.isFinite(info.birthtimeMs) ? info.birthtimeMs : null,
  };
}

function sameIdentity(left, right) {
  if (left.dev && left.ino && right.dev && right.ino && left.ino !== '0' && right.ino !== '0') {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.birthtimeMs != null && right.birthtimeMs != null && left.birthtimeMs === right.birthtimeMs;
}

async function assertRealDirectory(candidate, root = null) {
  const resolved = path.resolve(candidate);
  if (root) {
    const relative = path.relative(path.resolve(root), resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new PolicyError('worker exchange path escaped its control root');
  }
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError('worker exchange directory is not a real directory');
  const canonical = await realpath(resolved);
  if (canonical !== resolved && process.platform !== 'win32') throw new PolicyError('worker exchange directory canonical identity changed');
  return resolved;
}

export class WorkerExchange {
  #root;

  constructor({ root }) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new PolicyError('worker exchange root must be an absolute control-plane path');
    this.#root = path.resolve(root);
  }

  get root() { return this.#root; }

  async ensureRoot() {
    if (!(await exists(this.#root))) await mkdir(this.#root, { recursive: true, mode: 0o700 });
    return assertRealDirectory(this.#root);
  }

  async prepare({ runId, turnId, context }) {
    await this.ensureRoot();
    const run = safeId(runId, 'worker exchange runId');
    const turn = safeId(turnId, 'worker exchange turnId');
    const runDir = path.join(this.#root, run);
    const exchangeDir = path.join(runDir, turn);

    if (!(await exists(runDir))) await mkdir(runDir, { recursive: false, mode: 0o700 });
    await assertRealDirectory(runDir, this.#root);
    if (await exists(exchangeDir)) throw new PolicyError(`worker exchange turn already exists: ${run}/${turn}`);
    await mkdir(exchangeDir, { recursive: false, mode: 0o700 });
    await assertRealDirectory(exchangeDir, this.#root);

    const contextFile = path.join(exchangeDir, 'context.json');
    const resultFile = path.join(exchangeDir, 'result.json');
    const contextHandle = await open(contextFile, 'wx', 0o600);
    try { await contextHandle.writeFile(`${JSON.stringify(context, null, 2)}\n`, 'utf8'); }
    finally { await contextHandle.close(); }
    const resultHandle = await open(resultFile, 'wx', 0o600);
    await resultHandle.close();

    const [contextInfo, resultInfo] = await Promise.all([lstat(contextFile), lstat(resultFile)]);
    if (!contextInfo.isFile() || contextInfo.isSymbolicLink() || !resultInfo.isFile() || resultInfo.isSymbolicLink()) {
      throw new PolicyError('worker exchange endpoints are not stable regular files');
    }
    const resultIdentity = identity(resultInfo);

    return {
      runId: run,
      turnId: turn,
      exchangeDir,
      contextFile,
      resultFile,
      async consumeResult({ maxBytes = MAX_RESULT_BYTES } = {}) {
        await assertRealDirectory(exchangeDir, this.#root);
        const current = await lstat(resultFile);
        if (!current.isFile() || current.isSymbolicLink()) throw new PolicyError('worker result endpoint was replaced by a non-regular filesystem object');
        if (!sameIdentity(resultIdentity, identity(current))) throw new PolicyError('worker result endpoint identity changed after launch');
        if (current.size > maxBytes) throw new PolicyError(`worker result exceeds ${maxBytes} bytes`);
        return readFile(resultFile, 'utf8');
      },
      async cleanup() {
        await assertRealDirectory(exchangeDir, this.#root);
        await rm(exchangeDir, { recursive: true, force: true });
      },
    };
  }
}
