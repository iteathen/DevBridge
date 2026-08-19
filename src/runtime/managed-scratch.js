import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/u;

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function safeId(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value) || value === '.' || value === '..') throw new PolicyError(`${name} must be a safe local scratch identifier`);
  return value;
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

export class ManagedScratchTransaction {
  #workspace;
  #state;
  #persist;
  #faults;
  #effectGuard;
  #root;

  constructor({ workspace, state, persist, faultInjector = null, effectGuard = null }) {
    this.#workspace = workspace;
    this.#state = state;
    this.#persist = persist;
    this.#faults = faultInjector;
    if (effectGuard != null && typeof effectGuard !== 'function') throw new TypeError('ManagedScratchTransaction effectGuard must be a function');
    this.#effectGuard = effectGuard;
    const runId = safeId(String(workspace.runId ?? path.basename(workspace.worktreeDir)), 'scratch runId');
    this.#root = path.join(path.dirname(path.resolve(workspace.worktreeDir)), `.patch-poller-scratch-${runId}`);
    this.#state.controllerPlan ??= {};
    this.#state.controllerPlan.scratchLedger ??= [];
  }

  get root() { return this.#root; }

  async #guard() {
    if (this.#effectGuard) await this.#effectGuard();
  }

  async #ensureRoot() {
    const parent = path.dirname(this.#root);
    await assertDirectoryPathNoFollow(parent);
    if (await exists(this.#root)) {
      const info = await lstat(this.#root);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError('managed scratch root is not a real directory');
      return;
    }
    await this.#guard();
    await mkdir(this.#root, { recursive: false, mode: 0o700 });
    const info = await lstat(this.#root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PolicyError('managed scratch root creation was not stable');
    await this.#guard();
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
      await this.#guard();
      await mkdir(target, { recursive: false, mode: 0o700 });
      await this.#guard();
    }
    entry.state = 'created';
    entry.updatedAt = new Date().toISOString();
    await this.#persist();
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
        await this.#guard();
        await rm(target, { recursive: true, force: true });
        await this.#guard();
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
      await this.#guard();
      await rm(this.#root, { recursive: true, force: true });
      await this.#guard();
    }
    return {
      entries: ledger.length,
      verifiedAbsent: ledger.filter((entry) => entry.state === 'verified-absent').length,
      leftovers: ledger.filter((entry) => entry.state !== 'verified-absent').map((entry) => entry.id),
    };
  }
}
