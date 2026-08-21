import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EnvironmentLifecycleBusyError } from '../errors.js';

const PROTOCOL = 'devbridge/persistent-environments-v1';
const ENVIRONMENT_ID = /^env-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const BINDING = /^[a-f0-9]{32}$/u;
const MAX_SUBJECT_BYTES = 512;
const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;
const FIRMWARE = new Set(['efi', 'bios']);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function requireId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function requireEnvironmentId(value) {
  if (typeof value !== 'string' || !ENVIRONMENT_ID.test(value)) throw new TypeError('environment identity is invalid');
  return value;
}

function normalizeSubject(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SUBJECT_BYTES) {
    throw new TypeError('environment subject must be a bounded opaque identity');
  }
  return value;
}

function normalizeSettings(raw = {}) {
  const value = requireObject(raw, 'environment settings');
  onlyKeys(value, new Set(['memoryBytes', 'processorCount', 'firmware']), 'environment settings');
  const memoryBytes = value.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  const processorCount = value.processorCount ?? 2;
  const firmware = value.firmware ?? 'efi';
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < MIN_MEMORY_BYTES || memoryBytes > MAX_MEMORY_BYTES) {
    throw new TypeError('environment settings.memoryBytes is outside the supported safety range');
  }
  if (!Number.isSafeInteger(processorCount) || processorCount < 1 || processorCount > MAX_PROCESSORS) {
    throw new TypeError('environment settings.processorCount is outside the supported safety range');
  }
  if (!FIRMWARE.has(firmware)) throw new TypeError('environment settings.firmware is invalid');
  return { memoryBytes, processorCount, firmware };
}

function normalizeRequest(raw) {
  const value = requireObject(raw, 'environment request');
  onlyKeys(value, new Set(['subject', 'profile', 'sourceIdentity', 'settings']), 'environment request');
  return {
    subject: normalizeSubject(value.subject),
    profile: requireId(value.profile, 'environment profile'),
    sourceIdentity: requireId(value.sourceIdentity, 'environment source identity'),
    settings: normalizeSettings(value.settings ?? {}),
  };
}

function normalizeSource(raw, request) {
  const value = requireObject(raw, 'environment source');
  onlyKeys(value, new Set(['identity', 'profile', 'revision', 'digest', 'handle']), 'environment source');
  if (value.identity !== request.sourceIdentity) throw new Error('resolved environment source identity changed');
  if (value.profile !== request.profile) throw new Error('environment source profile does not match the requested profile');
  const revision = requireId(value.revision, 'environment source revision');
  const digest = String(value.digest ?? '').toLowerCase();
  if (!DIGEST.test(digest)) throw new TypeError('environment source digest is invalid');
  requireObject(value.handle, 'environment source handle');
  return {
    identity: value.identity,
    profile: value.profile,
    revision,
    digest,
    handle: value.handle,
  };
}

function sourceRecord(source) {
  return { identity: source.identity, profile: source.profile, revision: source.revision, digest: source.digest };
}

function operationSource(source) {
  return { identity: source.identity, revision: source.revision, digest: source.digest, handle: source.handle };
}

function sameSource(left, right) {
  return left?.identity === right?.identity && left?.profile === right?.profile && left?.revision === right?.revision && left?.digest === right?.digest;
}

function sameSettings(left, right) {
  return left?.memoryBytes === right?.memoryBytes && left?.processorCount === right?.processorCount && left?.firmware === right?.firmware;
}

function emptyCatalog() {
  return { protocol: PROTOCOL, revision: 0, entries: {}, operations: {} };
}

function slotIdentity(binding, subject, profile) {
  return createHash('sha256').update(`${binding}\0${subject}\0${profile}`, 'utf8').digest('hex').slice(0, 32);
}

function environmentIdentity(slot, generation, sourceIdentity) {
  return `env-${createHash('sha256').update(`${slot}\0${generation}\0${sourceIdentity}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function publicRecord(entry) {
  if (!entry) return null;
  return structuredClone({
    identity: entry.current.identity,
    subject: entry.subject,
    profile: entry.profile,
    generation: entry.current.generation,
    source: entry.current.source,
    settings: entry.current.settings,
    createdAt: entry.current.createdAt,
  });
}

function normalizeBinding(raw) {
  const value = requireObject(raw, 'environment operations status');
  onlyKeys(value, new Set(['identity']), 'environment operations status');
  if (typeof value.identity !== 'string' || !BINDING.test(value.identity)) throw new TypeError('environment operations identity is invalid');
  return value.identity;
}

function normalizeObservation(raw, expectedIdentity) {
  const value = requireObject(raw, 'environment observation');
  onlyKeys(value, new Set(['identity', 'exists', 'owned', 'compatible', 'state', 'reason', 'storage']), 'environment observation');
  if (value.identity !== expectedIdentity) throw new Error('environment observation identity changed');
  const exists = value.exists === true;
  const owned = value.owned === true;
  const compatible = value.compatible === true;
  const state = typeof value.state === 'string' && value.state.length > 0 ? value.state : 'unknown';
  const reason = value.reason == null ? null : String(value.reason).slice(0, 2048);
  let storage = null;
  if (value.storage != null) {
    const rawStorage = requireObject(value.storage, 'environment observation.storage');
    onlyKeys(rawStorage, new Set(['identity', 'sourceIdentity', 'allocatedBytes']), 'environment observation.storage');
    const allocatedBytes = rawStorage.allocatedBytes == null ? null : Number(rawStorage.allocatedBytes);
    if (allocatedBytes != null && (!Number.isSafeInteger(allocatedBytes) || allocatedBytes < 0)) throw new TypeError('environment observation.storage.allocatedBytes is invalid');
    storage = {
      identity: rawStorage.identity == null ? null : String(rawStorage.identity),
      sourceIdentity: rawStorage.sourceIdentity == null ? null : String(rawStorage.sourceIdentity),
      allocatedBytes,
    };
  }
  return { identity: expectedIdentity, exists, owned, compatible, state, reason, storage };
}

function requireObservedSource(observation, sourceIdentity) {
  if (!observation.storage || observation.storage.sourceIdentity !== sourceIdentity) {
    throw new Error('environment writable lineage does not match the intended source');
  }
}

function assertSource(value) {
  if (!value || typeof value.resolve !== 'function') throw new TypeError('environment source contract is incomplete');
  return value;
}

function assertOperations(value) {
  const methods = ['inspect', 'provision', 'observe', 'start', 'stop', 'drop'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('environment operations contract is incomplete');
  return value;
}

export class PersistentEnvironments {
  #directory;
  #catalogFile;
  #guardFile;
  #source;
  #operations;
  #tail = Promise.resolve();

  constructor({ directory, source, operations }) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('environment directory is required');
    this.#directory = path.resolve(directory);
    this.#catalogFile = path.join(this.#directory, 'catalog.json');
    this.#guardFile = path.join(this.#directory, 'lifecycle.lock');
    this.#source = assertSource(source);
    this.#operations = assertOperations(operations);
  }

  async #acquire() {
    await this.#ensureDirectory();
    const token = randomUUID();
    let handle;
    try {
      handle = await open(this.#guardFile, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new EnvironmentLifecycleBusyError('environment lifecycle mutation is already active; remove lifecycle.lock only after confirming no operation is running');
      }
      throw error;
    }
    try {
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(this.#guardFile, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    return async () => {
      const observed = (await readFile(this.#guardFile, 'utf8')).trim();
      if (observed !== token) throw new Error('environment lifecycle guard ownership changed');
      await rm(this.#guardFile);
    };
  }

  #serial(work) {
    const guarded = async () => {
      const release = await this.#acquire();
      try { return await work(); }
      finally { await release(); }
    };
    const next = this.#tail.then(guarded, guarded);
    this.#tail = next.catch(() => {});
    return next;
  }

  async #ensureDirectory() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment directory must be a real directory');
  }

  async #load() {
    await this.#ensureDirectory();
    try {
      const info = await lstat(this.#catalogFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment catalog must be a real file');
      const catalog = JSON.parse(await readFile(this.#catalogFile, 'utf8'));
      if (!catalog || catalog.protocol !== PROTOCOL || !catalog.entries || !catalog.operations) throw new Error('environment catalog is invalid');
      return catalog;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyCatalog();
      throw error;
    }
  }

  async #save(catalog) {
    catalog.revision = Number(catalog.revision ?? 0) + 1;
    const temporary = path.join(this.#directory, `.catalog-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(catalog)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#catalogFile);
  }

  async #binding() {
    return normalizeBinding(await this.#operations.inspect());
  }

  async #resolve(request, expected = null) {
    const resolved = normalizeSource(await this.#source.resolve(request.sourceIdentity), request);
    if (expected && !sameSource(sourceRecord(resolved), expected)) throw new Error('environment source lineage changed');
    return resolved;
  }

  #findEntry(catalog, identity) {
    const id = requireEnvironmentId(identity);
    for (const [slot, entry] of Object.entries(catalog.entries)) {
      if (entry.current?.identity === id) return { slot, entry };
      if ((entry.history ?? []).some((item) => item.identity === id)) throw new Error('environment identity is stale');
    }
    throw new Error('environment is not registered');
  }

  async #completeProvision(catalog, operation) {
    const request = {
      subject: operation.subject,
      profile: operation.profile,
      sourceIdentity: operation.source.identity,
      settings: operation.settings,
    };
    const resolved = await this.#resolve(request, operation.source);
    let observed = normalizeObservation(await this.#operations.observe(operation.identity), operation.identity);
    if (observed.exists) {
      if (!observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'existing environment conflicts with the intended provisioning effect');
      requireObservedSource(observed, operation.source.identity);
    } else {
      observed = normalizeObservation(await this.#operations.provision({
        identity: operation.identity,
        source: operationSource(resolved),
        settings: operation.settings,
      }), operation.identity);
      if (!observed.exists || !observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment provisioning did not produce an owned compatible environment');
      requireObservedSource(observed, operation.source.identity);
    }
    operation.state = 'attempted';
    operation.attemptedAt = new Date().toISOString();
    await this.#save(catalog);

    catalog.entries[operation.slot] = {
      slot: operation.slot,
      binding: operation.binding,
      subject: operation.subject,
      profile: operation.profile,
      current: {
        identity: operation.identity,
        generation: operation.generation,
        source: operation.source,
        settings: operation.settings,
        createdAt: operation.plannedAt,
      },
      history: [],
    };
    operation.state = 'reconciled';
    operation.reconciledAt = new Date().toISOString();
    await this.#save(catalog);
    return { record: publicRecord(catalog.entries[operation.slot]), observation: observed };
  }

  async ensure(raw) {
    return this.#serial(async () => {
      const request = normalizeRequest(raw);
      const binding = await this.#binding();
      const catalog = await this.#load();
      const matching = Object.values(catalog.entries).find((entry) => entry.subject === request.subject && entry.profile === request.profile);
      if (matching) {
        if (matching.binding !== binding) throw new Error('environment attachment identity changed; existing state will not be silently reused');
        if (matching.current.source.identity !== request.sourceIdentity) throw new Error('environment source changed; explicit reseed is required');
        if (!sameSettings(matching.current.settings, request.settings)) throw new Error('environment settings changed; explicit reset or reseed is required');
        await this.#resolve(request, matching.current.source);
        const observed = normalizeObservation(await this.#operations.observe(matching.current.identity), matching.current.identity);
        if (!observed.exists || !observed.owned || !observed.compatible) {
          throw new Error(observed.reason ?? 'registered environment state is missing or incompatible; explicit recovery is required');
        }
        requireObservedSource(observed, matching.current.source.identity);
        return { record: publicRecord(matching), observation: observed };
      }

      const source = await this.#resolve(request);
      const slot = slotIdentity(binding, request.subject, request.profile);
      const generation = 1;
      const identity = environmentIdentity(slot, generation, source.identity);
      const operationId = `op-${randomUUID()}`;
      catalog.operations[operationId] = {
        id: operationId,
        kind: 'provision',
        state: 'planned',
        binding,
        slot,
        identity,
        generation,
        subject: request.subject,
        profile: request.profile,
        source: sourceRecord(source),
        settings: request.settings,
        plannedAt: new Date().toISOString(),
      };
      await this.#save(catalog);
      return this.#completeProvision(catalog, catalog.operations[operationId]);
    });
  }

  async #observeEntry(entry) {
    const observation = normalizeObservation(await this.#operations.observe(entry.current.identity), entry.current.identity);
    if (observation.exists && observation.owned && observation.compatible) requireObservedSource(observation, entry.current.source.identity);
    return { record: publicRecord(entry), observation };
  }

  async list() {
    return this.#serial(async () => {
      const binding = await this.#binding();
      const catalog = await this.#load();
      const values = [];
      for (const entry of Object.values(catalog.entries)) {
        if (entry.binding !== binding) {
          values.push({ record: publicRecord(entry), observation: { identity: entry.current.identity, exists: false, owned: false, compatible: false, state: 'unavailable', reason: 'environment attachment identity changed', storage: null } });
          continue;
        }
        values.push(await this.#observeEntry(entry));
      }
      return values;
    });
  }

  async observe(identity) {
    return this.#serial(async () => {
      const binding = await this.#binding();
      const catalog = await this.#load();
      const { entry } = this.#findEntry(catalog, identity);
      if (entry.binding !== binding) return { record: publicRecord(entry), observation: { identity: entry.current.identity, exists: false, owned: false, compatible: false, state: 'unavailable', reason: 'environment attachment identity changed', storage: null } };
      return this.#observeEntry(entry);
    });
  }

  async #completeTransition(catalog, operation) {
    const entry = Object.values(catalog.entries).find((candidate) => candidate.current?.identity === operation.identity);
    if (!entry) throw new Error('environment transition subject disappeared');
    let observed = normalizeObservation(await this.#operations.observe(operation.identity), operation.identity);
    if (!observed.exists || !observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment is unavailable for lifecycle transition');
    requireObservedSource(observed, entry.current.source.identity);
    const stopped = ['stopped', 'shut off', 'off', 'shutdown'].includes(observed.state);
    const running = ['running', 'blocked'].includes(observed.state);
    if (operation.kind === 'start' && !running) observed = normalizeObservation(await this.#operations.start(operation.identity), operation.identity);
    if (operation.kind === 'stop' && !stopped) observed = normalizeObservation(await this.#operations.stop(operation.identity, operation.options ?? {}), operation.identity);
    if (!observed.exists || !observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment lifecycle transition did not preserve an owned compatible environment');
    requireObservedSource(observed, entry.current.source.identity);
    operation.state = 'reconciled';
    operation.reconciledAt = new Date().toISOString();
    await this.#save(catalog);
    return observed;
  }

  async #transition(kind, identity, options = {}) {
    return this.#serial(async () => {
      const binding = await this.#binding();
      const catalog = await this.#load();
      const { entry } = this.#findEntry(catalog, identity);
      if (entry.binding !== binding) throw new Error('environment attachment identity changed');
      const operationId = `op-${randomUUID()}`;
      catalog.operations[operationId] = { id: operationId, kind, state: 'planned', binding, identity: entry.current.identity, options, plannedAt: new Date().toISOString() };
      await this.#save(catalog);
      const observation = await this.#completeTransition(catalog, catalog.operations[operationId]);
      return { record: publicRecord(entry), observation };
    });
  }

  async start(identity) { return this.#transition('start', identity); }

  async stop(identity, { force = false, timeoutMs = 60_000 } = {}) {
    if (typeof force !== 'boolean') throw new TypeError('environment stop force must be boolean');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new TypeError('environment stop timeoutMs is invalid');
    return this.#transition('stop', identity, { force, timeoutMs });
  }

  async #completeRotate(catalog, operation) {
    const found = Object.values(catalog.entries).find((entry) => entry.slot === operation.slot);
    if (!found) throw new Error('environment rotation subject disappeared');
    if (found.current.identity !== operation.oldIdentity && found.current.identity !== operation.newIdentity) throw new Error('environment rotation subject changed unexpectedly');

    if (found.current.identity === operation.oldIdentity) {
      let oldObserved = normalizeObservation(await this.#operations.observe(operation.oldIdentity), operation.oldIdentity);
      if (!oldObserved.exists || !oldObserved.owned || !oldObserved.compatible) throw new Error(oldObserved.reason ?? 'current environment is unavailable for reset');
      requireObservedSource(oldObserved, operation.oldSource.identity);
      const stopped = ['stopped', 'shut off', 'off', 'shutdown'].includes(oldObserved.state);
      if (!stopped) oldObserved = normalizeObservation(await this.#operations.stop(operation.oldIdentity, { force: true, timeoutMs: 60_000 }), operation.oldIdentity);
      if (!['stopped', 'shut off', 'off', 'shutdown'].includes(oldObserved.state)) throw new Error('current environment did not stop before rotation');
      requireObservedSource(oldObserved, operation.oldSource.identity);

      const request = { subject: found.subject, profile: found.profile, sourceIdentity: operation.source.identity, settings: operation.settings };
      const resolved = await this.#resolve(request, operation.source);
      let nextObserved = normalizeObservation(await this.#operations.observe(operation.newIdentity), operation.newIdentity);
      if (nextObserved.exists) {
        if (!nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'existing replacement environment conflicts with the intended rotation');
        requireObservedSource(nextObserved, operation.source.identity);
      } else {
        nextObserved = normalizeObservation(await this.#operations.provision({ identity: operation.newIdentity, source: operationSource(resolved), settings: operation.settings }), operation.newIdentity);
        if (!nextObserved.exists || !nextObserved.owned || !nextObserved.compatible) throw new Error(nextObserved.reason ?? 'replacement environment did not provision compatibly');
        requireObservedSource(nextObserved, operation.source.identity);
      }
      operation.state = 'attempted';
      operation.attemptedAt = new Date().toISOString();
      await this.#save(catalog);

      found.history ??= [];
      found.history.push({ ...found.current, supersededAt: new Date().toISOString(), removedAt: null });
      found.current = {
        identity: operation.newIdentity,
        generation: operation.generation,
        source: operation.source,
        settings: operation.settings,
        createdAt: operation.plannedAt,
      };
      operation.state = 'switched';
      operation.switchedAt = new Date().toISOString();
      await this.#save(catalog);
    }

    const removal = await this.#operations.drop(operation.oldIdentity);
    if (!removal || (removal.removed !== true && removal.absent !== true)) throw new Error('superseded environment removal did not reconcile');
    const history = found.history ?? [];
    const old = history.find((item) => item.identity === operation.oldIdentity);
    if (old && old.removedAt == null) old.removedAt = new Date().toISOString();
    operation.state = 'reconciled';
    operation.reconciledAt = new Date().toISOString();
    await this.#save(catalog);
    return this.#observeEntry(found);
  }

  async #rotate(identity, sourceIdentity = null) {
    return this.#serial(async () => {
      const binding = await this.#binding();
      const catalog = await this.#load();
      const { slot, entry } = this.#findEntry(catalog, identity);
      if (entry.binding !== binding) throw new Error('environment attachment identity changed');
      const request = {
        subject: entry.subject,
        profile: entry.profile,
        sourceIdentity: sourceIdentity ?? entry.current.source.identity,
        settings: entry.current.settings,
      };
      const resolved = await this.#resolve(request, sourceIdentity == null ? entry.current.source : null);
      const generation = Number(entry.current.generation) + 1;
      const newIdentity = environmentIdentity(slot, generation, resolved.identity);
      const operationId = `op-${randomUUID()}`;
      catalog.operations[operationId] = {
        id: operationId,
        kind: 'rotate',
        state: 'planned',
        binding,
        slot,
        oldIdentity: entry.current.identity,
        newIdentity,
        generation,
        source: sourceRecord(resolved),
        oldSource: structuredClone(entry.current.source),
        settings: entry.current.settings,
        plannedAt: new Date().toISOString(),
      };
      await this.#save(catalog);
      return this.#completeRotate(catalog, catalog.operations[operationId]);
    });
  }

  async reset(identity) { return this.#rotate(identity); }
  async reseed(identity, { sourceIdentity }) { return this.#rotate(identity, requireId(sourceIdentity, 'environment source identity')); }

  async #completeRemove(catalog, operation) {
    const found = Object.values(catalog.entries).find((entry) => entry.current?.identity === operation.identity);
    if (found) {
      let observed = normalizeObservation(await this.#operations.observe(operation.identity), operation.identity);
      if (observed.exists && (!observed.owned || !observed.compatible)) throw new Error(observed.reason ?? 'environment ownership evidence does not match');
      if (observed.exists) requireObservedSource(observed, found.current.source.identity);
      if (observed.exists && !['stopped', 'shut off', 'off', 'shutdown'].includes(observed.state)) {
        observed = normalizeObservation(await this.#operations.stop(operation.identity, { force: true, timeoutMs: 60_000 }), operation.identity);
        requireObservedSource(observed, found.current.source.identity);
      }
      const removal = await this.#operations.drop(operation.identity);
      if (!removal || (removal.removed !== true && removal.absent !== true)) throw new Error('environment removal did not reconcile');
      delete catalog.entries[operation.slot];
    } else {
      const removal = await this.#operations.drop(operation.identity);
      if (!removal || (removal.removed !== true && removal.absent !== true)) throw new Error('environment removal did not reconcile');
    }
    operation.state = 'reconciled';
    operation.reconciledAt = new Date().toISOString();
    await this.#save(catalog);
    return { identity: operation.identity, removed: true };
  }

  async remove(identity) {
    return this.#serial(async () => {
      const binding = await this.#binding();
      const catalog = await this.#load();
      const { slot, entry } = this.#findEntry(catalog, identity);
      if (entry.binding !== binding) throw new Error('environment attachment identity changed');
      const operationId = `op-${randomUUID()}`;
      catalog.operations[operationId] = { id: operationId, kind: 'remove', state: 'planned', binding, slot, identity: entry.current.identity, plannedAt: new Date().toISOString() };
      await this.#save(catalog);
      return this.#completeRemove(catalog, catalog.operations[operationId]);
    });
  }

  async reconcile() {
    return this.#serial(async () => {
      const binding = await this.#binding();
      let catalog = await this.#load();
      for (const operation of Object.values(catalog.operations)) {
        if (operation.state === 'reconciled' || operation.state === 'failed') continue;
        if (operation.binding !== binding) throw new Error('environment attachment identity changed; pending effects will not be replayed');
        if (operation.kind === 'provision') await this.#completeProvision(catalog, operation);
        else if (operation.kind === 'start' || operation.kind === 'stop') await this.#completeTransition(catalog, operation);
        else if (operation.kind === 'rotate') await this.#completeRotate(catalog, operation);
        else if (operation.kind === 'remove') await this.#completeRemove(catalog, operation);
        else throw new Error(`unknown environment operation kind: ${operation.kind}`);
        catalog = await this.#load();
      }
      const values = [];
      for (const entry of Object.values(catalog.entries)) {
        if (entry.binding !== binding) {
          values.push({ record: publicRecord(entry), observation: { identity: entry.current.identity, exists: false, owned: false, compatible: false, state: 'unavailable', reason: 'environment attachment identity changed', storage: null } });
        } else {
          values.push(await this.#observeEntry(entry));
        }
      }
      return values;
    });
  }

  async protectedSourceIdentities() {
    return this.#serial(async () => {
      const catalog = await this.#load();
      const identities = new Set();
      for (const entry of Object.values(catalog.entries)) identities.add(entry.current.source.identity);
      for (const operation of Object.values(catalog.operations)) {
        if (operation.state !== 'reconciled' && operation.state !== 'failed') {
          if (operation.source?.identity) identities.add(operation.source.identity);
          if (operation.oldSource?.identity) identities.add(operation.oldSource.identity);
        }
      }
      return [...identities].sort();
    });
  }
}

export { PROTOCOL as PERSISTENT_ENVIRONMENTS_PROTOCOL };

export class UnavailablePersistentOperations {
  #identity;
  #reason;
  constructor({ identity, reason = 'persistent environment operations are unavailable' }) {
    if (typeof identity !== 'string' || !BINDING.test(identity)) throw new TypeError('environment operations identity is invalid');
    this.#identity = identity;
    this.#reason = String(reason);
  }
  async inspect() { return { identity: this.#identity }; }
  async provision() { throw new Error(this.#reason); }
  async observe(identity) { return { identity, exists: false, owned: false, compatible: false, state: 'unavailable', reason: this.#reason, storage: null }; }
  async start() { throw new Error(this.#reason); }
  async stop() { throw new Error(this.#reason); }
  async drop() { throw new Error(this.#reason); }
}
