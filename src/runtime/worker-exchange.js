import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';

export const WORKER_EXCHANGE_PROTOCOL = 'devbridge/worker-exchange-v1';
export const WORKER_CONTEXT_TRANSFER = 'context';
export const WORKER_RESULT_TRANSFER = 'result';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const DEFAULT_RESULT_LIMIT = 1_048_576;
const MANIFEST_LIMIT = 64 * 1024;

function sha256(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }

function validateSegment(value, name) {
  const text = String(value ?? '');
  if (!SAFE_SEGMENT.test(text) || text === '.' || text === '..') throw new PolicyError(`${name} is not a safe worker-exchange identity segment`);
  return text;
}

function identityOf(info) { return { dev: String(info.dev), ino: String(info.ino) }; }
function sameIdentity(info, expected) {
  if (!expected || typeof expected !== 'object') return false;
  const actual = identityOf(info);
  return actual.dev === String(expected.dev) && actual.ino === String(expected.ino);
}
function linkCount(info) {
  if (typeof info.nlink === 'bigint') return info.nlink;
  if (Number.isSafeInteger(info.nlink) && info.nlink >= 0) return BigInt(info.nlink);
  return 0n;
}
function assertAnchoredPair(primaryInfo, anchorInfo, primaryFile) {
  if (linkCount(primaryInfo) < 2n || linkCount(anchorInfo) < 2n || linkCount(primaryInfo) !== linkCount(anchorInfo) || !sameIdentity(primaryInfo, anchorInfo)) {
    throw new PolicyError(`${primaryFile} was replaced after DevBridge established worker-exchange ownership`);
  }
}
function expectedUid() {
  const uid = process.getuid?.();
  return Number.isInteger(uid) ? BigInt(uid) : null;
}
function assertOwned(info, name) {
  const uid = expectedUid();
  if (uid != null && info.uid !== uid) throw new PolicyError(`${name} is not owned by the DevBridge service identity`);
}
function assertPrivateMode(info, name) {
  if (expectedUid() != null && (info.mode & 0o077n) !== 0n) throw new PolicyError(`${name} is accessible outside the DevBridge service identity`);
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
function assertOpenedFile(info, name) {
  if (!info.isFile()) throw new PolicyError(`${name} must remain a regular file while opened`);
  assertOwned(info, name);
  assertPrivateMode(info, name);
}
async function secureStat(candidate, kind, expectedIdentity = null) {
  const info = await lstat(candidate, { bigint: true });
  if (kind === 'directory') assertDirectory(info, candidate); else assertFile(info, candidate);
  if (expectedIdentity && !sameIdentity(info, expectedIdentity)) throw new PolicyError(`${candidate} was replaced after DevBridge established worker-exchange ownership`);
  return info;
}
async function ensurePrivateDirectory(candidate) {
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const initial = await lstat(candidate, { bigint: true });
  if (initial.isSymbolicLink() || !initial.isDirectory()) throw new PolicyError(`${candidate} must be a real DevBridge-owned directory`);
  assertOwned(initial, candidate);
  if (expectedUid() != null && (initial.mode & 0o077n) !== 0n) await chmod(candidate, 0o700);
  return secureStat(candidate, 'directory');
}
async function openNoFollow(candidate, flags) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  try { return await open(candidate, flags | noFollow); }
  catch (error) {
    if (noFollow !== 0 && (error?.code === 'EINVAL' || error?.code === 'ENOTSUP')) return open(candidate, flags);
    throw error;
  }
}
async function readAnchoredFile({ candidate, anchor, expectedCandidateIdentity = null, expectedAnchorIdentity = null, maxBytes = null }) {
  const beforeCandidate = await secureStat(candidate, 'file', expectedCandidateIdentity);
  const beforeAnchor = await secureStat(anchor, 'file', expectedAnchorIdentity);
  assertAnchoredPair(beforeCandidate, beforeAnchor, candidate);
  const candidateIdentity = expectedCandidateIdentity ?? identityOf(beforeCandidate);
  const anchorIdentity = expectedAnchorIdentity ?? identityOf(beforeAnchor);
  const candidateHandle = await openNoFollow(candidate, constants.O_RDONLY);
  const anchorHandle = await openNoFollow(anchor, constants.O_RDONLY);
  try {
    const openedCandidate = await candidateHandle.stat({ bigint: true });
    const openedAnchor = await anchorHandle.stat({ bigint: true });
    assertOpenedFile(openedCandidate, candidate);
    assertOpenedFile(openedAnchor, anchor);
    assertAnchoredPair(openedCandidate, openedAnchor, candidate);
    const tooLarge = maxBytes != null && openedCandidate.size > BigInt(maxBytes);
    const text = tooLarge ? null : await candidateHandle.readFile({ encoding: 'utf8' });
    const afterCandidate = await secureStat(candidate, 'file', candidateIdentity);
    const afterAnchor = await secureStat(anchor, 'file', anchorIdentity);
    assertAnchoredPair(afterCandidate, afterAnchor, candidate);
    return { info: openedCandidate, text, tooLarge };
  } finally {
    await Promise.all([candidateHandle.close().catch(() => {}), anchorHandle.close().catch(() => {})]);
  }
}

async function writeAnchoredFile({ candidate, anchor, expectedCandidateIdentity, expectedAnchorIdentity, bytes, maxBytes }) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (payload.length > maxBytes) throw new PolicyError(`worker result transfer exceeds ${maxBytes} bytes`);
  const beforeCandidate = await secureStat(candidate, 'file', expectedCandidateIdentity);
  const beforeAnchor = await secureStat(anchor, 'file', expectedAnchorIdentity);
  assertAnchoredPair(beforeCandidate, beforeAnchor, candidate);
  const candidateHandle = await openNoFollow(candidate, constants.O_WRONLY | constants.O_TRUNC);
  const anchorHandle = await openNoFollow(anchor, constants.O_RDONLY);
  try {
    const openedCandidate = await candidateHandle.stat({ bigint: true });
    const openedAnchor = await anchorHandle.stat({ bigint: true });
    assertOpenedFile(openedCandidate, candidate);
    assertOpenedFile(openedAnchor, anchor);
    assertAnchoredPair(openedCandidate, openedAnchor, candidate);
    if (payload.length > 0) await candidateHandle.writeFile(payload);
    await candidateHandle.sync();
  } finally {
    await Promise.all([candidateHandle.close().catch(() => {}), anchorHandle.close().catch(() => {})]);
  }
  const afterCandidate = await secureStat(candidate, 'file', expectedCandidateIdentity);
  const afterAnchor = await secureStat(anchor, 'file', expectedAnchorIdentity);
  assertAnchoredPair(afterCandidate, afterAnchor, candidate);
}

async function readControlManifest(candidate, anchor) {
  const read = await readAnchoredFile({ candidate, anchor, maxBytes: MANIFEST_LIMIT });
  if (read.tooLarge) throw new PolicyError('worker-exchange manifest exceeds the control-plane size bound');
  let parsed;
  try { parsed = JSON.parse(read.text); }
  catch (error) { throw new PolicyError('worker-exchange manifest is malformed', { cause: error }); }
  if (parsed?.protocol !== WORKER_EXCHANGE_PROTOCOL) throw new PolicyError('worker-exchange manifest protocol is invalid');
  return parsed;
}

class WorkerMailbox {
  #turnRoot;
  #contextFile;
  #contextAnchorFile;
  #resultFile;
  #resultAnchorFile;
  #manifest;

  constructor({ turnRoot, contextFile, contextAnchorFile, resultFile, resultAnchorFile, manifest }) {
    this.#turnRoot = turnRoot;
    this.#contextFile = contextFile;
    this.#contextAnchorFile = contextAnchorFile;
    this.#resultFile = resultFile;
    this.#resultAnchorFile = resultAnchorFile;
    this.#manifest = manifest;
  }

  get contextFile() { return this.#contextFile; }
  get resultFile() { return this.#resultFile; }

  inputTransfer() {
    return {
      name: WORKER_CONTEXT_TRANSFER,
      direction: 'input',
      port: {
        read: async () => {
          const read = await readAnchoredFile({
            candidate: this.#contextFile,
            anchor: this.#contextAnchorFile,
            expectedCandidateIdentity: this.#manifest.contextIdentity,
            expectedAnchorIdentity: this.#manifest.contextAnchorIdentity,
          });
          if (sha256(read.text) !== this.#manifest.contextSha256) throw new PolicyError('worker context changed after DevBridge established it');
          return Buffer.from(read.text, 'utf8');
        },
      },
    };
  }

  outputTransfer({ maxBytes = DEFAULT_RESULT_LIMIT } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216) throw new PolicyError('worker result size bound is invalid');
    return {
      name: WORKER_RESULT_TRANSFER,
      direction: 'output',
      port: {
        write: async (bytes) => writeAnchoredFile({
          candidate: this.#resultFile,
          anchor: this.#resultAnchorFile,
          expectedCandidateIdentity: this.#manifest.resultIdentity,
          expectedAnchorIdentity: this.#manifest.resultAnchorIdentity,
          bytes,
          maxBytes,
        }),
      },
    };
  }

  async consumeResult({ maxBytes = DEFAULT_RESULT_LIMIT } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216) throw new PolicyError('worker result size bound is invalid');
    await secureStat(this.#turnRoot, 'directory', this.#manifest.turnIdentity);
    const context = await readAnchoredFile({
      candidate: this.#contextFile,
      anchor: this.#contextAnchorFile,
      expectedCandidateIdentity: this.#manifest.contextIdentity,
      expectedAnchorIdentity: this.#manifest.contextAnchorIdentity,
    });
    if (sha256(context.text) !== this.#manifest.contextSha256) throw new PolicyError('worker modified its control-plane-owned context file');
    const result = await readAnchoredFile({
      candidate: this.#resultFile,
      anchor: this.#resultAnchorFile,
      expectedCandidateIdentity: this.#manifest.resultIdentity,
      expectedAnchorIdentity: this.#manifest.resultAnchorIdentity,
      maxBytes,
    });
    if (result.tooLarge) return { text: null, resultParseError: `result file exceeds ${maxBytes} bytes` };
    if (result.info.size === 0n) return { text: null, resultParseError: null };
    return { text: result.text, resultParseError: null };
  }
}

export class WorkerExchange {
  #stateDirectory;
  #rootDirectory;

  constructor({ stateDirectory } = {}) {
    if (typeof stateDirectory !== 'string' || stateDirectory.trim() === '') throw new PolicyError('worker exchange requires a control-plane state directory');
    this.#stateDirectory = path.resolve(stateDirectory);
    this.#rootDirectory = path.join(this.#stateDirectory, 'worker-exchange');
  }
  get rootDirectory() { return this.#rootDirectory; }
  async #ensureRoot() { await ensurePrivateDirectory(this.#stateDirectory); await ensurePrivateDirectory(this.#rootDirectory); }
  #paths(runId, turnId) {
    const safeRunId = validateSegment(runId, 'runId');
    const safeTurnId = validateSegment(turnId, 'turnId');
    const runRoot = path.join(this.#rootDirectory, safeRunId);
    const turnRoot = path.join(runRoot, safeTurnId);
    return {
      safeRunId, safeTurnId, runRoot, turnRoot,
      contextFile: path.join(turnRoot, 'context.json'),
      contextAnchorFile: path.join(turnRoot, '.context-anchor'),
      resultFile: path.join(turnRoot, 'result.json'),
      resultAnchorFile: path.join(turnRoot, '.result-anchor'),
      manifestFile: path.join(turnRoot, 'manifest.json'),
      manifestAnchorFile: path.join(turnRoot, '.manifest-anchor'),
    };
  }

  async prepareTurn({ runId, turnId, context }) {
    await this.#ensureRoot();
    const paths = this.#paths(runId, turnId);
    try { await mkdir(paths.runRoot, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    await secureStat(paths.runRoot, 'directory');
    try { await mkdir(paths.turnRoot, { mode: 0o700 }); }
    catch (error) {
      if (error?.code === 'EEXIST') throw new PolicyError('worker-exchange turn already exists; use recovery inspection instead of reusing a mailbox');
      throw error;
    }
    const turnInfo = await secureStat(paths.turnRoot, 'directory');
    const contextText = `${JSON.stringify(context, null, 2)}\n`;
    await writeFile(paths.contextFile, contextText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await link(paths.contextFile, paths.contextAnchorFile);
    await writeFile(paths.resultFile, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await link(paths.resultFile, paths.resultAnchorFile);
    const contextInfo = await secureStat(paths.contextFile, 'file');
    const contextAnchorInfo = await secureStat(paths.contextAnchorFile, 'file');
    assertAnchoredPair(contextInfo, contextAnchorInfo, paths.contextFile);
    const resultInfo = await secureStat(paths.resultFile, 'file');
    const resultAnchorInfo = await secureStat(paths.resultAnchorFile, 'file');
    assertAnchoredPair(resultInfo, resultAnchorInfo, paths.resultFile);
    const manifest = {
      protocol: WORKER_EXCHANGE_PROTOCOL,
      runId: paths.safeRunId,
      turnId: paths.safeTurnId,
      createdAt: new Date().toISOString(),
      contextSha256: sha256(contextText),
      turnIdentity: identityOf(turnInfo),
      contextIdentity: identityOf(contextInfo),
      contextAnchorIdentity: identityOf(contextAnchorInfo),
      resultIdentity: identityOf(resultInfo),
      resultAnchorIdentity: identityOf(resultAnchorInfo),
      transfers: { input: WORKER_CONTEXT_TRANSFER, output: WORKER_RESULT_TRANSFER },
    };
    await writeFile(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await link(paths.manifestFile, paths.manifestAnchorFile);
    const manifestInfo = await secureStat(paths.manifestFile, 'file');
    const manifestAnchorInfo = await secureStat(paths.manifestAnchorFile, 'file');
    assertAnchoredPair(manifestInfo, manifestAnchorInfo, paths.manifestFile);
    return new WorkerMailbox({ turnRoot: paths.turnRoot, contextFile: paths.contextFile, contextAnchorFile: paths.contextAnchorFile, resultFile: paths.resultFile, resultAnchorFile: paths.resultAnchorFile, manifest });
  }

  async openTurn({ runId, turnId }) {
    await this.#ensureRoot();
    const paths = this.#paths(runId, turnId);
    await secureStat(paths.runRoot, 'directory');
    await secureStat(paths.turnRoot, 'directory');
    const manifest = await readControlManifest(paths.manifestFile, paths.manifestAnchorFile);
    if (manifest.runId !== paths.safeRunId || manifest.turnId !== paths.safeTurnId) throw new PolicyError('worker-exchange manifest does not match the requested run/turn identity');
    if (manifest.transfers?.input !== WORKER_CONTEXT_TRANSFER || manifest.transfers?.output !== WORKER_RESULT_TRANSFER) {
      throw new PolicyError('worker-exchange manifest transfer identities are invalid');
    }
    await secureStat(paths.turnRoot, 'directory', manifest.turnIdentity);
    const contextInfo = await secureStat(paths.contextFile, 'file', manifest.contextIdentity);
    const contextAnchorInfo = await secureStat(paths.contextAnchorFile, 'file', manifest.contextAnchorIdentity);
    assertAnchoredPair(contextInfo, contextAnchorInfo, paths.contextFile);
    const resultInfo = await secureStat(paths.resultFile, 'file', manifest.resultIdentity);
    const resultAnchorInfo = await secureStat(paths.resultAnchorFile, 'file', manifest.resultAnchorIdentity);
    assertAnchoredPair(resultInfo, resultAnchorInfo, paths.resultFile);
    return new WorkerMailbox({ turnRoot: paths.turnRoot, contextFile: paths.contextFile, contextAnchorFile: paths.contextAnchorFile, resultFile: paths.resultFile, resultAnchorFile: paths.resultAnchorFile, manifest });
  }
}
