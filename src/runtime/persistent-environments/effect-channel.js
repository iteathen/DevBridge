const DIGEST = /^[a-f0-9]{64}$/u;
const BINDING = /^[a-f0-9]{32}$/u;
const STORAGE_STATES = new Set(['unknown', 'absent', 'present', 'invalid']);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function requireId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
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
  return { identity: value.identity, profile: value.profile, revision, digest, handle: value.handle };
}

function normalizeObservation(raw, expectedIdentity) {
  const value = requireObject(raw, 'environment observation');
  onlyKeys(value, new Set(['identity', 'exists', 'owned', 'compatible', 'state', 'reason', 'storage', 'storageState']), 'environment observation');
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
  const storageState = value.storageState == null
    ? storage != null ? (compatible ? 'present' : 'invalid') : 'unknown'
    : String(value.storageState);
  if (!STORAGE_STATES.has(storageState)) throw new TypeError('environment observation.storageState is invalid');
  return { identity: expectedIdentity, exists, owned, compatible, state, reason, storage, storageState };
}

function assertSource(value) {
  if (!value || typeof value.resolve !== 'function') throw new TypeError('environment source contract is incomplete');
  return value;
}

function assertActions(value) {
  const methods = ['inspect', 'provision', 'observe', 'start', 'stop', 'drop'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('environment operations contract is incomplete');
  return value;
}

export class EnvironmentEffectChannel {
  #source;
  #actions;

  constructor({ source, actions }) {
    this.#source = assertSource(source);
    this.#actions = assertActions(actions);
  }

  async binding() {
    const value = requireObject(await this.#actions.inspect(), 'environment operations status');
    onlyKeys(value, new Set(['identity']), 'environment operations status');
    if (typeof value.identity !== 'string' || !BINDING.test(value.identity)) throw new TypeError('environment operations identity is invalid');
    return value.identity;
  }

  async resolve(request, expected = null) {
    const resolved = normalizeSource(await this.#source.resolve(request.sourceIdentity), request);
    if (expected && !this.sameSource(this.record(resolved), expected)) throw new Error('environment source lineage changed');
    return resolved;
  }

  record(source) {
    return { identity: source.identity, profile: source.profile, revision: source.revision, digest: source.digest };
  }

  sameSource(left, right) {
    return left?.identity === right?.identity && left?.profile === right?.profile && left?.revision === right?.revision && left?.digest === right?.digest;
  }

  async observe(identity) {
    return normalizeObservation(await this.#actions.observe(identity), identity);
  }

  async provision({ identity, source, settings }) {
    return normalizeObservation(await this.#actions.provision({
      identity,
      source: { identity: source.identity, revision: source.revision, digest: source.digest, handle: source.handle },
      settings,
    }), identity);
  }

  async start(identity) {
    return normalizeObservation(await this.#actions.start(identity), identity);
  }

  async stop(identity, options) {
    return normalizeObservation(await this.#actions.stop(identity, options), identity);
  }

  canQuiesce() {
    return typeof this.#actions.quiesce === 'function';
  }

  async quiesce(identity) {
    if (!this.canQuiesce()) throw new Error('environment cannot be quiesced');
    return normalizeObservation(await this.#actions.quiesce(identity), identity);
  }

  async drop(identity) {
    return this.#actions.drop(identity);
  }

  requireSource(observation, sourceIdentity) {
    if (!observation.storage || observation.storage.sourceIdentity !== sourceIdentity) {
      throw new Error('environment writable lineage does not match the intended source');
    }
  }

  stopped(value) {
    return ['stopped', 'shut off', 'off', 'shutdown', 'crashed'].includes(String(value ?? '').toLowerCase());
  }

  running(value) {
    return ['running', 'blocked'].includes(value);
  }
}
