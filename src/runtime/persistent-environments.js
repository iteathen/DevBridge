import { createHash, randomUUID } from 'node:crypto';
import { EnvironmentEffectChannel } from './persistent-environments/effect-channel.js';
import { EnvironmentGenerationChange } from './persistent-environments/generation-change.js';
import { EnvironmentLedger } from './persistent-environments/ledger.js';
import { EnvironmentOrdinaryLifecycle } from './persistent-environments/ordinary-lifecycle.js';
import { EnvironmentProvisioning } from './persistent-environments/provisioning.js';
import { EnvironmentRetirement } from './persistent-environments/retirement.js';

const PROTOCOL = 'devbridge/persistent-environments-v1';
const ENVIRONMENT_ID = /^env-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
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

function sameSettings(left, right) {
  return left?.memoryBytes === right?.memoryBytes && left?.processorCount === right?.processorCount && left?.firmware === right?.firmware;
}

function slotIdentity(binding, subject, profile) {
  return createHash('sha256').update(`${binding}\0${subject}\0${profile}`, 'utf8').digest('hex').slice(0, 32);
}

function environmentIdentity(slot, generation, sourceIdentity) {
  return `env-${createHash('sha256').update(`${slot}\0${generation}\0${sourceIdentity}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function operationIdentity() {
  return `op-${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
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

function findEntry(state, identity) {
  const id = requireEnvironmentId(identity);
  for (const [slot, entry] of Object.entries(state.entries)) {
    if (entry.current?.identity === id) return { slot, entry };
    if ((entry.history ?? []).some((item) => item.identity === id)) throw new Error('environment identity is stale');
  }
  throw new Error('environment is not registered');
}

export class PersistentEnvironments {
  #ledger;
  #effects;
  #provisioning;
  #lifecycle;
  #generation;
  #retirement;

  constructor({ directory, source, operations }) {
    this.#ledger = new EnvironmentLedger({ directory, protocol: PROTOCOL });
    this.#effects = new EnvironmentEffectChannel({ source, actions: operations });
    const ports = {
      effects: this.#effects,
      commit: (state) => this.#ledger.commit(state),
      present: publicRecord,
      find: findEntry,
      environmentIdentity,
      operationIdentity,
      now,
    };
    this.#provisioning = new EnvironmentProvisioning({ ...ports, slotIdentity, sameSettings });
    this.#lifecycle = new EnvironmentOrdinaryLifecycle(ports);
    this.#generation = new EnvironmentGenerationChange(ports);
    this.#retirement = new EnvironmentRetirement(ports);
  }

  async ensure(raw) {
    return this.#ledger.run(async () => this.#provisioning.ensure(await this.#ledger.read(), normalizeRequest(raw)));
  }

  async list() {
    return this.#ledger.run(async () => {
      const binding = await this.#effects.binding();
      return this.#lifecycle.list(await this.#ledger.read(), binding);
    });
  }

  async observe(identity) {
    return this.#ledger.run(async () => {
      const binding = await this.#effects.binding();
      return this.#lifecycle.observe(await this.#ledger.read(), binding, identity);
    });
  }

  async #transition(kind, identity, options = {}) {
    return this.#ledger.run(async () => {
      const binding = await this.#effects.binding();
      return this.#lifecycle.transition(await this.#ledger.read(), binding, kind, identity, options);
    });
  }

  async start(identity) { return this.#transition('start', identity); }

  async stop(identity, { force = false, timeoutMs = 60_000 } = {}) {
    if (typeof force !== 'boolean') throw new TypeError('environment stop force must be boolean');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new TypeError('environment stop timeoutMs is invalid');
    return this.#transition('stop', identity, { force, timeoutMs });
  }

  async #rotate(identity, sourceIdentity = null) {
    return this.#ledger.run(async () => {
      const binding = await this.#effects.binding();
      return this.#generation.rotate(await this.#ledger.read(), binding, identity, sourceIdentity);
    });
  }

  async reset(identity) { return this.#rotate(identity); }

  async reseed(identity, { sourceIdentity }) {
    return this.#rotate(identity, requireId(sourceIdentity, 'environment source identity'));
  }

  async replace(identity, { requestId, expectedPreviousIdentity } = {}) {
    return this.#ledger.run(async () => {
      const requested = requireEnvironmentId(identity);
      const requestIdentity = requireId(requestId, 'environment replacement request identity');
      const expectedPrevious = requireEnvironmentId(expectedPreviousIdentity);
      const binding = await this.#effects.binding();
      return this.#generation.replace(await this.#ledger.read(), binding, requested, requestIdentity, expectedPrevious);
    });
  }

  async recreate(identity, { requestId, expectedPreviousIdentity } = {}) {
    return this.#ledger.run(async () => {
      const requested = requireEnvironmentId(identity);
      const requestIdentity = requireId(requestId, 'environment recreate request identity');
      const expectedPrevious = requireEnvironmentId(expectedPreviousIdentity);
      const binding = await this.#effects.binding();
      return this.#generation.recreate(await this.#ledger.read(), binding, requested, requestIdentity, expectedPrevious);
    });
  }

  async rebuild(identity, { requestId, expectedPreviousIdentity } = {}) {
    return this.#ledger.run(async () => {
      const requested = requireEnvironmentId(identity);
      const requestIdentity = requireId(requestId, 'environment rebuild request identity');
      const expectedPrevious = requireEnvironmentId(expectedPreviousIdentity);
      const binding = await this.#effects.binding();
      return this.#generation.rebuild(await this.#ledger.read(), binding, requested, requestIdentity, expectedPrevious);
    });
  }

  async retireSuperseded(identity, { supersededIdentity } = {}) {
    return this.#ledger.run(async () => {
      const currentIdentity = requireEnvironmentId(identity);
      const oldIdentity = requireEnvironmentId(supersededIdentity);
      const binding = await this.#effects.binding();
      return this.#retirement.retireSuperseded(await this.#ledger.read(), binding, currentIdentity, oldIdentity);
    });
  }

  async remove(identity) {
    return this.#ledger.run(async () => {
      const binding = await this.#effects.binding();
      return this.#retirement.remove(await this.#ledger.read(), binding, identity);
    });
  }

  async reconcile() {
    return this.#ledger.run(async () => {
      const binding = await this.#effects.binding();
      let state = await this.#ledger.read();
      for (const operation of Object.values(state.operations)) {
        if (operation.state === 'reconciled' || operation.state === 'failed') continue;
        if (operation.binding !== binding) throw new Error('environment attachment identity changed; pending effects will not be replayed');
        if (operation.kind === 'provision') await this.#provisioning.resume(state, operation);
        else if (operation.kind === 'start' || operation.kind === 'stop') await this.#lifecycle.resume(state, operation);
        else if (operation.kind === 'rotate') await this.#generation.resumeRotate(state, operation);
        else if (operation.kind === 'replace' || operation.kind === 'rebuild' || operation.kind === 'recreate') continue;
        else if (operation.kind === 'remove') await this.#retirement.resumeRemove(state, operation);
        else throw new Error(`unknown environment operation kind: ${operation.kind}`);
        state = await this.#ledger.read();
      }
      return this.#lifecycle.list(state, binding);
    });
  }

  async protectedSourceIdentities() {
    return this.#ledger.run(async () => {
      const state = await this.#ledger.read();
      const identities = new Set();
      for (const entry of Object.values(state.entries)) identities.add(entry.current.source.identity);
      for (const operation of Object.values(state.operations)) {
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
  async observe(identity) { return { identity, exists: false, owned: false, compatible: false, state: 'unavailable', reason: this.#reason, storage: null, storageState: 'unknown' }; }
  async start() { throw new Error(this.#reason); }
  async stop() { throw new Error(this.#reason); }
  async drop() { throw new Error(this.#reason); }
}
