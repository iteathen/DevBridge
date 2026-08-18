import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/u;
const WORKER_EXCLUDES = new Set(['.git', '.patch-poller']);

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function safeId(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value) || value === '.' || value === '..') throw new PolicyError(`${name} must be a safe local scratch identifier`);
  return value;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertDirectoryPathNoFollow(candidate) {
  const resolved = path.resolve(candidate);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  const segments = relative.split(path.sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new PolicyError('managed scratch parent crosses filesystem indirection');
    if (!info.isDirectory()) throw new PolicyError('managed scratch parent contains a non-directory path component');
  }
  return resolved;
}

async function copyWorkerTree(sourceRoot, source, destination, active = new Set()) {
  let effectiveSource = source;
  let info = await lstat(effectiveSource);
  if (info.isSymbolicLink()) {
    effectiveSource = await realpath(effectiveSource);
    if (!within(sourceRoot, effectiveSource)) throw new PolicyError('worker mirror source symlink escapes authoritative project root');
    if (active.has(effectiveSource)) throw new PolicyError('worker mirror source contains a symlink cycle');
    info = await lstat(effectiveSource);
  }

  const identity = await realpath(effectiveSource).catch(() => effectiveSource);
  if (active.has(identity)) throw new PolicyError('worker mirror source contains a filesystem cycle');

  if (info.isDirectory()) {
    active.add(identity);
    await mkdir(destination, { recursive: false, mode: info.mode & 0o777 });
    const entries = await readdir(effectiveSource, { withFileTypes: true });
    for (const entry of entries) {
      if (WORKER_EXCLUDES.has(entry.name)) continue;
      await copyWorkerTree(sourceRoot, path.join(effectiveSource, entry.name), path.join(destination, entry.name), active);
    }
    active.delete(identity);
    return;
  }

  if (!info.isFile()) throw new PolicyError('worker mirror source contains an unsupported filesystem object');
  await copyFile(effectiveSource, destination);
  try { await chmod(destination, info.mode & 0o777); } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

export class ManagedScratchTransaction {
  #workspace;
  #state;
  #persist;
  #faults;
  #root;
  #projectMirror = null;

  constructor({ workspace, state, persist, faultInjector = null }) {
    this.#workspace = workspace;
    this.#state = state;
    this.#persist = persist;
    this.#faults = faultInjector;
    const runId = safeId(String(workspace.runId ?? path.basename(workspace.worktreeDir)), 'scratch runId');
    this.#root = path.join(path.dirname(path.resolve(workspace.worktreeDir)), `.patch-poller-scratch-${runId}`);
    this.#state.controllerPlan ??= {};
    this.#state.controllerPlan.scratchLedger ??= [];
  }

  get root() { return this.#root; }

  async #ensureRoot() {
    const parent = path.dirname(this.#root);
    await assertDirectoryPathNoFollow(parent);
    if (await exists(this.#root)) {
      const info = await lstat(this.#root);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError('managed scratch root is not a real directory');
      return;
    }
    await mkdir(this.#root, { recursive: false, mode: 0o700 });
    const info = await lstat(this.#root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError('managed scratch root creation was not stable');
  }

  async directory(id) {
    const safe = safeId(id, 'scratch id');
    const ledger = this.#state.controllerPlan.scratchLedger;
    let entry = ledger.find((candidate) => candidate.id === safe);
    if (!entry) {
      entry = { id: safe, kind: 'directory', state: 'planned', updatedAt: new Date().toISOString() };
      ledger.push(entry);
      await this.#persist();
    } else if (entry.state === 'removed' || entry.state === 'verified-absent') {
      entry.state = 'planned';
      entry.updatedAt = new Date().toISOString();
      await this.#persist();
    }

    await this.#ensureRoot();
    const target = path.join(this.#root, safe);
    if (await exists(target)) {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError(`managed scratch ${safe} was replaced by an unsafe filesystem object`);
    } else {
      await mkdir(target, { recursive: false, mode: 0o700 });
    }
    entry.state = 'created';
    entry.updatedAt = new Date().toISOString();
    await this.#persist();
    return target;
  }

  async projectMirror(sourceDir = this.#workspace.worktreeDir) {
    if (this.#projectMirror) return this.#projectMirror;
    const sourceRoot = path.resolve(sourceDir);
    const sourceInfo = await lstat(sourceRoot);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new PolicyError('authoritative project root is not a real directory');
    const sourceReal = await realpath(sourceRoot);
    const target = await this.directory('worker-project');

    // Never trust bytes left by a prior interrupted worker. Reconstruct the
    // disposable candidate mirror from the control-plane-owned worktree.
    await rm(target, { recursive: true, force: true });
    this.#state.controllerPlan.workerMirror = {
      state: 'reconstructing',
      excludes: [...WORKER_EXCLUDES].sort(),
      updatedAt: new Date().toISOString(),
    };
    await this.#persist();
    await copyWorkerTree(sourceReal, sourceReal, target);
    this.#state.controllerPlan.workerMirror = {
      state: 'ready',
      excludes: [...WORKER_EXCLUDES].sort(),
      gitAdministrativeStateExposed: false,
      updatedAt: new Date().toISOString(),
    };
    await this.#persist();
    this.#projectMirror = target;
    return target;
  }

  async cleanup() {
    const ledger = this.#state.controllerPlan.scratchLedger ?? [];
    for (const entry of ledger) {
      if (entry.state === 'verified-absent') continue;
      const safe = safeId(entry.id, 'scratch ledger id');
      const target = path.join(this.#root, safe);
      entry.state = 'cleanup-planned';
      entry.updatedAt = new Date().toISOString();
      await this.#persist();
      this.#faults?.throwIfTriggered('scratch.cleanup.before-remove', { operation: safe });
      if (await exists(target)) {
        const info = await lstat(target);
        if (info.isSymbolicLink()) throw new PolicyError(`managed scratch ${safe} became a symbolic link before cleanup`);
        await rm(target, { recursive: true, force: true });
      }
      entry.state = 'removed';
      entry.updatedAt = new Date().toISOString();
      await this.#persist();
      if (await exists(target)) throw new PolicyError(`managed scratch cleanup failed for ${safe}`);
      entry.state = 'verified-absent';
      entry.updatedAt = new Date().toISOString();
      await this.#persist();
    }
    if (await exists(this.#root)) {
      const info = await lstat(this.#root);
      if (info.isSymbolicLink()) throw new PolicyError('managed scratch root became a symbolic link before cleanup');
      await rm(this.#root, { recursive: true, force: true });
    }
    this.#projectMirror = null;
    return {
      entries: ledger.length,
      verifiedAbsent: ledger.filter((entry) => entry.state === 'verified-absent').length,
      leftovers: ledger.filter((entry) => entry.state !== 'verified-absent').map((entry) => entry.id),
    };
  }
}
