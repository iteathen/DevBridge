import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';

export const WORKER_EXCHANGE_PROTOCOL = 'patch-poller/worker-exchange-v1';
export const WORKER_CONTEXT_FILE = '/run/patch-poller-exchange/context.json';
export const WORKER_RESULT_FILE = '/run/patch-poller-exchange/result.json';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const DEFAULT_RESULT_LIMIT = 1_048_576;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validateSegment(value, name) {
  const text = String(value ?? '');
  if (!SAFE_SEGMENT.test(text) || text === '.' || text === '..') {
    throw new PolicyError(`${name} is not a safe worker-exchange identity segment`);
  }
  return text;
}

function identityOf(info) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs ?? 0n),
  };
}

function sameIdentity(info, expected) {
  const actual = identityOf(info);
  return actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.birthtimeNs === expected.birthtimeNs;
}

function expectedUid() {
  const uid = process.getuid?.();
  return Number.isInteger(uid) ? BigInt(uid) : null;
}

function assertOwned(info, name) {
  const uid = expectedUid();
  if (uid != null && info.uid !== uid) throw new PolicyError(`${name} is not owned by the PATCH-POLLER service identity`);
}

function assertPrivateMode(info, name) {
  if ((info.mode & 0o077n) !== 0n) throw new PolicyError(`${name} is accessible outside the PATCH-POLLER service identity`);
}

function assertDirectory(info, name) {
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError(`${name} must be a real directory, not filesystem indirection`);
  assertOwned(info, name);
  assertPrivateMode(info, name);
}

function assertFile(info, name) {
  if (info.isSymbolicLink() || !info.isFile()) throw new PolicyError(`${name} must be a real regular file, not filesystem indirection`);
  assertOwned(info, name);
  assertPrivateMode(info, name);
}

async function secureStat(candidate, kind, expectedIdentity = null) {
  const info = await lstat(candidate, { bigint: true });
  if (kind === 'directory') assertDirectory(info, candidate);
  else assertFile(info, candidate);
  if (expectedIdentity && !sameIdentity(info, expectedIdentity)) {
    throw new PolicyError(`${candidate} was replaced after PATCH-POLLER established worker-exchange ownership`);
  }
  return info;
}

async function ensurePrivateDirectory(candidate) {
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const initial = await lstat(candidate, { bigint: true });
  if (initial.isSymbolicLink() || !initial.isDirectory()) {
    throw new PolicyError(`${candidate} must be a real PATCH-POLLER-owned directory`);
  }
  assertOwned(initial, candidate);
  if ((initial.mode & 0o077n) !== 0n) await chmod(candidate, 0o700);
  return secureStat(candidate, 'directory');
}

async function openReadNoFollow(candidate) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  try {
    return await open(candidate, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (noFollow !== 0 && (error?.code === 'EINVAL' || error?.code === 'ENOTSUP')) {
      return open(candidate, constants.O_RDONLY);
    }
    throw error;
  }
}

async function readExactFile(candidate, expectedIdentity) {
  const before = await secureStat(candidate, 'file', expectedIdentity);
  const handle = await openReadNoFollow(candidate);
  try {
    const opened = await handle.stat({ bigint: true });
    assertFile(opened, candidate);
    if (!sameIdentity(opened, expectedIdentity) || !sameIdentity(before, expectedIdentity)) {
      throw new PolicyError(`${candidate} changed identity during privileged worker-exchange read`);
    }
    return { info: opened, text: await handle.readFile({ encoding: 'utf8' }) };
  } finally {
    await handle.close();
  }
}

async function readControlManifest(candidate) {
  const info = await secureStat(candidate, 'file');
  if (info.size > 64n * 1024n) throw new PolicyError('worker-exchange manifest exceeds the control-plane size bound');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(candidate, 'utf8'));
  } catch (error) {
    throw new PolicyError('worker-exchange manifest is malformed', { cause: error });
  }
  if (parsed?.protocol !== WORKER_EXCHANGE_PROTOCOL) throw new PolicyError('worker-exchange manifest protocol is invalid');
  return parsed;
}

class WorkerMailbox {
  #turnRoot;
  #contextFile;
  #resultFile;
  #manifest;

  constructor({ turnRoot, contextFile, resultFile, manifest }) {
    this.#turnRoot = turnRoot;
    this.#contextFile = contextFile;
    this.#resultFile = resultFile;
    this.#manifest = manifest;
  }

  get contextFile() { return this.#contextFile; }
  get resultFile() { return this.#resultFile; }
  get workerContextFile() { return WORKER_CONTEXT_FILE; }
  get workerResultFile() { return WORKER_RESULT_FILE; }

  sandboxIpc() {
    return {
      protocol: WORKER_EXCHANGE_PROTOCOL,
      contextSource: this.#contextFile,
      resultSource: this.#resultFile,
      contextTarget: WORKER_CONTEXT_FILE,
      resultTarget: WORKER_RESULT_FILE,
    };
  }

  async consumeResult({ maxBytes = DEFAULT_RESULT_LIMIT } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216) {
      throw new PolicyError('worker result size bound is invalid');
    }
    await secureStat(this.#turnRoot, 'directory', this.#manifest.turnIdentity);

    const context = await readExactFile(this.#contextFile, this.#manifest.contextIdentity);
    if (sha256(context.text) !== this.#manifest.contextSha256) {
      throw new PolicyError('worker modified its control-plane-owned context file');
    }

    const resultInfo = await secureStat(this.#resultFile, 'file', this.#manifest.resultIdentity);
    if (resultInfo.size > BigInt(maxBytes)) {
      return { text: null, resultParseError: `result file exceeds ${maxBytes} bytes` };
    }
    if (resultInfo.size === 0n) return { text: null, resultParseError: null };
    const result = await readExactFile(this.#resultFile, this.#manifest.resultIdentity);
    return { text: result.text, resultParseError: null };
  }
}

export class WorkerExchange {
  #stateDirectory;
  #rootDirectory;

  constructor({ stateDirectory } = {}) {
    if (typeof stateDirectory !== 'string' || stateDirectory.trim() === '') {
      throw new PolicyError('worker exchange requires a control-plane state directory');
    }
    this.#stateDirectory = path.resolve(stateDirectory);
    this.#rootDirectory = path.join(this.#stateDirectory, 'worker-exchange');
  }

  get rootDirectory() { return this.#rootDirectory; }

  async #ensureRoot() {
    await ensurePrivateDirectory(this.#stateDirectory);
    await ensurePrivateDirectory(this.#rootDirectory);
  }

  #paths(runId, turnId) {
    const safeRunId = validateSegment(runId, 'runId');
    const safeTurnId = validateSegment(turnId, 'turnId');
    const runRoot = path.join(this.#rootDirectory, safeRunId);
    const turnRoot = path.join(runRoot, safeTurnId);
    return {
      safeRunId,
      safeTurnId,
      runRoot,
      turnRoot,
      contextFile: path.join(turnRoot, 'context.json'),
      resultFile: path.join(turnRoot, 'result.json'),
      manifestFile: path.join(turnRoot, 'manifest.json'),
    };
  }

  async prepareTurn({ runId, turnId, context }) {
    await this.#ensureRoot();
    const paths = this.#paths(runId, turnId);

    try {
      await mkdir(paths.runRoot, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await secureStat(paths.runRoot, 'directory');

    try {
      await mkdir(paths.turnRoot, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new PolicyError('worker-exchange turn already exists; use recovery inspection instead of reusing a mailbox');
      }
      throw error;
    }
    const turnInfo = await secureStat(paths.turnRoot, 'directory');

    const contextText = `${JSON.stringify(context, null, 2)}\n`;
    await writeFile(paths.contextFile, contextText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await writeFile(paths.resultFile, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const contextInfo = await secureStat(paths.contextFile, 'file');
    const resultInfo = await secureStat(paths.resultFile, 'file');

    const manifest = {
      protocol: WORKER_EXCHANGE_PROTOCOL,
      runId: paths.safeRunId,
      turnId: paths.safeTurnId,
      createdAt: new Date().toISOString(),
      contextSha256: sha256(contextText),
      turnIdentity: identityOf(turnInfo),
      contextIdentity: identityOf(contextInfo),
      resultIdentity: identityOf(resultInfo),
      workerContextFile: WORKER_CONTEXT_FILE,
      workerResultFile: WORKER_RESULT_FILE,
    };
    await writeFile(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await secureStat(paths.manifestFile, 'file');

    return new WorkerMailbox({
      turnRoot: paths.turnRoot,
      contextFile: paths.contextFile,
      resultFile: paths.resultFile,
      manifest,
    });
  }

  async openTurn({ runId, turnId }) {
    await this.#ensureRoot();
    const paths = this.#paths(runId, turnId);
    await secureStat(paths.runRoot, 'directory');
    await secureStat(paths.turnRoot, 'directory');
    const manifest = await readControlManifest(paths.manifestFile);
    if (manifest.runId !== paths.safeRunId || manifest.turnId !== paths.safeTurnId) {
      throw new PolicyError('worker-exchange manifest does not match the requested run/turn identity');
    }
    if (manifest.workerContextFile !== WORKER_CONTEXT_FILE || manifest.workerResultFile !== WORKER_RESULT_FILE) {
      throw new PolicyError('worker-exchange manifest uses unexpected sandbox-visible IPC paths');
    }
    await secureStat(paths.turnRoot, 'directory', manifest.turnIdentity);
    await secureStat(paths.contextFile, 'file', manifest.contextIdentity);
    await secureStat(paths.resultFile, 'file', manifest.resultIdentity);
    return new WorkerMailbox({
      turnRoot: paths.turnRoot,
      contextFile: paths.contextFile,
      resultFile: paths.resultFile,
      manifest,
    });
  }
}
