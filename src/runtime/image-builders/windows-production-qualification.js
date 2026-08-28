import { createHash } from 'node:crypto';

export const WINDOWS_PRODUCTION_QUALIFICATION_PROTOCOL = 'devbridge/windows-production-qualification-v1';
export const WINDOWS_PRODUCTION_FINALIZATION_PROTOCOL = 'devbridge/windows-production-finalization-v1';

const STATE_PROTOCOL = 'devbridge/windows-production-qualification-state-v1';
const TARGET = /^subject-[a-f0-9]{32}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+ -]{0,159}$/u;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const PHASES = new Set([
  'planned',
  'prepare-attempted',
  'prepared',
  'restart-attempted',
  'restart-requested',
  'restarted',
  'qualified',
  'finalization-attempted',
  'finalization-requested',
  'finalized',
]);

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function bounded(value, name, pattern = VERSION) {
  if (typeof value !== 'string' || !pattern.test(value) || Buffer.byteLength(value, 'utf8') > 512) throw new TypeError(`${name} is invalid`);
  return value;
}

function bootIdentity(value, name) {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function normalizeExpected(raw) {
  const value = onlyKeys(raw, new Set([
    'build', 'edition', 'architecture', 'installationType', 'defaultLanguage',
    'authorityGeneration', 'payloadGeneration', 'nodeVersion', 'sourceControlVersion', 'nativeBuildVersion',
  ]), 'production qualification expectation');
  if (!Number.isSafeInteger(value.build) || value.build < 10_000 || value.build > 999_999) throw new TypeError('production qualification build is invalid');
  if (value.architecture !== 'amd64') throw new TypeError('production qualification architecture is unsupported');
  if (!['Client', 'Server'].includes(value.installationType)) throw new TypeError('production qualification installationType is invalid');
  return Object.freeze({
    build: value.build,
    edition: bounded(value.edition, 'production qualification edition', GENERATION),
    architecture: value.architecture,
    installationType: value.installationType,
    defaultLanguage: bounded(value.defaultLanguage, 'production qualification defaultLanguage', LANGUAGE),
    authorityGeneration: bounded(value.authorityGeneration, 'production qualification authorityGeneration', GENERATION),
    payloadGeneration: bounded(value.payloadGeneration, 'production qualification payloadGeneration', GENERATION),
    nodeVersion: bounded(value.nodeVersion, 'production qualification nodeVersion', GENERATION),
    sourceControlVersion: bounded(value.sourceControlVersion, 'production qualification sourceControlVersion', GENERATION),
    nativeBuildVersion: bounded(value.nativeBuildVersion, 'production qualification nativeBuildVersion', GENERATION),
  });
}

function normalizeRecord(raw, target, expectedDigest) {
  if (raw == null) return null;
  const value = onlyKeys(raw, new Set([
    'protocol', 'target', 'expectedDigest', 'revision', 'phase', 'initialBootIdentity', 'bootIdentity', 'evidence',
  ]), 'production qualification record');
  if (value.protocol !== STATE_PROTOCOL || value.target !== target || value.expectedDigest !== expectedDigest) throw new Error('production qualification state identity changed');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || !PHASES.has(value.phase)) throw new Error('production qualification state is invalid');
  const initialBootIdentity = value.initialBootIdentity == null ? null : bootIdentity(value.initialBootIdentity, 'production qualification stored initial boot identity');
  const selectedBootIdentity = value.bootIdentity == null ? null : bootIdentity(value.bootIdentity, 'production qualification stored boot identity');
  const evidence = value.evidence == null ? null : normalizeEvidence(value.evidence);
  return { ...value, initialBootIdentity, bootIdentity: selectedBootIdentity, evidence };
}

function normalizeOperationResult(raw, allowed, name) {
  return onlyKeys(raw, allowed, name);
}

function normalizeStatus(raw) {
  const value = normalizeOperationResult(raw, new Set(['protocol', 'bootIdentity', 'ready']), 'production status evidence');
  if (value.protocol !== 'devbridge/windows-production-status-v1' || typeof value.ready !== 'boolean') throw new Error('production status evidence is invalid');
  return { bootIdentity: bootIdentity(value.bootIdentity, 'production status boot identity'), ready: value.ready };
}

function normalizeEvidence(raw) {
  const value = onlyKeys(raw, new Set([
    'protocol', 'source', 'tools', 'authorityGeneration', 'payloadGeneration',
    'bootIdentity', 'network', 'cmakeCtest', 'services', 'restarted', 'sanitized',
  ]), 'production qualification evidence');
  if (value.protocol !== WINDOWS_PRODUCTION_QUALIFICATION_PROTOCOL) throw new Error('production qualification evidence protocol is invalid');
  const source = onlyKeys(value.source, new Set(['os', 'build', 'edition', 'architecture', 'installationType', 'language']), 'production qualification source evidence');
  const tools = onlyKeys(value.tools, new Set(['node', 'npm', 'sourceControl', 'nativeBuild', 'cmake', 'compiler']), 'production qualification tool evidence');
  if (!Number.isSafeInteger(source.build) || source.build < 10_000 || source.build > 999_999) throw new Error('production qualification source build is invalid');
  for (const [name, entry] of Object.entries(source)) if (name !== 'build') bounded(entry, `production qualification source ${name}`);
  for (const [name, entry] of Object.entries(tools)) bounded(entry, `production qualification tool ${name}`);
  for (const name of ['authorityGeneration', 'payloadGeneration']) bounded(value[name], `production qualification ${name}`, GENERATION);
  bootIdentity(value.bootIdentity, 'production qualification boot identity');
  for (const name of ['network', 'cmakeCtest', 'services', 'restarted', 'sanitized']) if (typeof value[name] !== 'boolean') throw new Error(`production qualification ${name} is invalid`);
  return structuredClone(value);
}

function qualifyEvidence(raw, expected, priorBootIdentity) {
  const value = normalizeOperationResult(raw, new Set([
    'protocol', 'os', 'build', 'edition', 'architecture', 'installationType', 'language',
    'bootIdentity', 'node', 'npm', 'sourceControl', 'nativeBuild', 'cmake', 'compiler',
    'authorityGeneration', 'payloadGeneration', 'network', 'cmakeCtest', 'services',
  ]), 'production qualification operation result');
  if (value.protocol !== WINDOWS_PRODUCTION_QUALIFICATION_PROTOCOL) throw new Error('production qualification operation protocol is invalid');
  const observedBuild = Number(value.build);
  const observedBootIdentity = bootIdentity(value.bootIdentity, 'production qualification operation boot identity');
  if (
    observedBuild !== expected.build
    || value.edition !== expected.edition
    || value.architecture !== expected.architecture
    || value.installationType !== expected.installationType
    || value.language !== expected.defaultLanguage
    || value.authorityGeneration !== expected.authorityGeneration
    || value.payloadGeneration !== expected.payloadGeneration
    || value.node !== `v${expected.nodeVersion}`
    || value.sourceControl !== `git version ${expected.sourceControlVersion}`
    || value.nativeBuild !== expected.nativeBuildVersion
    || value.network !== true
    || value.cmakeCtest !== true
    || value.services !== true
    || observedBootIdentity === priorBootIdentity
    || !new RegExp(`^10\\.0\\.${expected.build}(?:\\.\\d+)?$`, 'u').test(String(value.os))
  ) throw new Error('production qualification evidence does not match the required image contract');
  for (const name of ['npm', 'cmake', 'compiler']) bounded(value[name], `production qualification operation ${name}`);
  return normalizeEvidence({
    protocol: WINDOWS_PRODUCTION_QUALIFICATION_PROTOCOL,
    source: {
      os: value.os,
      build: observedBuild,
      edition: value.edition,
      architecture: value.architecture,
      installationType: value.installationType,
      language: value.language,
    },
    tools: {
      node: value.node,
      npm: value.npm,
      sourceControl: value.sourceControl,
      nativeBuild: value.nativeBuild,
      cmake: value.cmake,
      compiler: value.compiler,
    },
    authorityGeneration: value.authorityGeneration,
    payloadGeneration: value.payloadGeneration,
    bootIdentity: observedBootIdentity,
    network: true,
    cmakeCtest: true,
    services: true,
    restarted: true,
    sanitized: false,
  });
}

function observeState(raw, target) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.identity !== target) throw new Error('production qualification observation identity changed');
  if (raw.exists !== true || raw.owned !== true || !['running', 'off'].includes(raw.state)) throw new Error('production qualification target is unavailable');
  return raw.state;
}

export class WindowsProductionQualification {
  #journal;
  #operations;
  #observe;
  #sleep;
  #now;
  #pollMs;
  #restartTimeoutMs;
  #finalizationTimeoutMs;

  constructor({
    journal,
    operations,
    observe,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
    pollMs = 2_000,
    restartTimeoutMs = 15 * 60_000,
    finalizationTimeoutMs = 30 * 60_000,
  } = {}) {
    if (!journal || typeof journal.load !== 'function' || typeof journal.save !== 'function') throw new TypeError('production qualification journal contract is incomplete');
    if (!operations || typeof operations.execute !== 'function') throw new TypeError('production qualification operation contract is incomplete');
    if (typeof observe !== 'function') throw new TypeError('production qualification observation contract is incomplete');
    if (typeof sleep !== 'function' || typeof now !== 'function') throw new TypeError('production qualification timing contract is incomplete');
    if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 30_000) throw new TypeError('production qualification poll interval is invalid');
    if (!Number.isSafeInteger(restartTimeoutMs) || restartTimeoutMs < pollMs || restartTimeoutMs > 60 * 60_000) throw new TypeError('production qualification restart timeout is invalid');
    if (!Number.isSafeInteger(finalizationTimeoutMs) || finalizationTimeoutMs < pollMs || finalizationTimeoutMs > 60 * 60_000) throw new TypeError('production qualification finalization timeout is invalid');
    this.#journal = journal;
    this.#operations = operations;
    this.#observe = observe;
    this.#sleep = sleep;
    this.#now = now;
    this.#pollMs = pollMs;
    this.#restartTimeoutMs = restartTimeoutMs;
    this.#finalizationTimeoutMs = finalizationTimeoutMs;
  }

  async #save(record, phase, changes = {}) {
    const next = { ...record, ...changes, protocol: STATE_PROTOCOL, phase, revision: record.revision + 1 };
    await this.#journal.save(record.target, next);
    return next;
  }

  async #execute(target, operation, timeoutMs) {
    return this.#operations.execute({ target, operation, input: {}, timeoutMs });
  }

  async #status(target) {
    try {
      return normalizeStatus(await this.#execute(target, 'status-v1', 30_000));
    } catch (error) {
      observeState(await this.#observe(target), target);
      throw error;
    }
  }

  async #waitForRestart(target, previousBootIdentity) {
    const deadline = this.#now() + this.#restartTimeoutMs;
    while (this.#now() <= deadline) {
      try {
        const status = await this.#status(target);
        if (status.ready && status.bootIdentity !== previousBootIdentity) return status.bootIdentity;
      } catch {
        observeState(await this.#observe(target), target);
      }
      if (this.#now() >= deadline) break;
      await this.#sleep(this.#pollMs);
    }
    throw new Error('production restart did not reconcile before its bounded deadline');
  }

  async #waitForOff(target) {
    const deadline = this.#now() + this.#finalizationTimeoutMs;
    while (this.#now() <= deadline) {
      if (observeState(await this.#observe(target), target) === 'off') return;
      if (this.#now() >= deadline) break;
      await this.#sleep(this.#pollMs);
    }
    throw new Error('production finalization did not reach shutdown before its bounded deadline');
  }

  async probe({ target, expected: rawExpected } = {}) {
    if (typeof target !== 'string' || !TARGET.test(target)) throw new TypeError('production qualification target is invalid');
    const expected = normalizeExpected(rawExpected);
    const expectedDigest = digest(expected);
    let record = normalizeRecord(await this.#journal.load(target), target, expectedDigest);
    if (!record) {
      record = { protocol: STATE_PROTOCOL, target, expectedDigest, revision: 0, phase: 'planned', initialBootIdentity: null, bootIdentity: null, evidence: null };
      record = await this.#save(record, 'planned');
    }
    if (record.phase === 'qualified') return normalizeEvidence(record.evidence);
    if (record.phase.startsWith('finalization') || record.phase === 'finalized') throw new Error('production qualification cannot be replayed after finalization intent');

    if (['planned', 'prepare-attempted'].includes(record.phase)) {
      if (record.phase === 'planned') record = await this.#save(record, 'prepare-attempted');
      const prepared = normalizeOperationResult(await this.#execute(target, 'prepare-v1', 60 * 60_000), new Set([
        'prepared', 'generation', 'payloadGeneration', 'nativeBuildVersion', 'bootIdentity', 'restartRequired',
      ]), 'production preparation result');
      if (
        prepared.prepared !== true
        || prepared.generation !== expected.authorityGeneration
        || prepared.payloadGeneration !== expected.payloadGeneration
        || prepared.nativeBuildVersion !== expected.nativeBuildVersion
        || prepared.restartRequired !== true
      ) throw new Error('production preparation did not satisfy the required contract');
      const preparedBootIdentity = bootIdentity(prepared.bootIdentity, 'production preparation boot identity');
      record = await this.#save(record, 'prepared', { initialBootIdentity: preparedBootIdentity, bootIdentity: preparedBootIdentity });
    }

    if (record.phase === 'prepared') {
      record = await this.#save(record, 'restart-attempted');
      const restarted = normalizeOperationResult(await this.#execute(target, 'restart-v1', 60_000), new Set(['scheduled']), 'production restart result');
      if (restarted.scheduled !== true) throw new Error('production restart was not scheduled');
      record = await this.#save(record, 'restart-requested');
    }

    if (['restart-attempted', 'restart-requested'].includes(record.phase)) {
      const restartedBootIdentity = await this.#waitForRestart(target, record.bootIdentity);
      record = await this.#save(record, 'restarted', { bootIdentity: restartedBootIdentity });
    }

    if (record.phase === 'restarted') {
      const evidence = qualifyEvidence(await this.#execute(target, 'qualify-v1', 30 * 60_000), expected, record.initialBootIdentity);
      if (evidence.bootIdentity !== record.bootIdentity) throw new Error('production qualification boot identity changed after restart reconciliation');
      record = await this.#save(record, 'qualified', { evidence });
    }

    if (record.phase !== 'qualified') throw new Error('production qualification did not reach its terminal probe state');
    return normalizeEvidence(record.evidence);
  }

  async finalize(rawTarget) {
    if (typeof rawTarget !== 'string' || !TARGET.test(rawTarget)) throw new TypeError('production qualification target is invalid');
    const stored = await this.#journal.load(rawTarget);
    if (!stored || stored.protocol !== STATE_PROTOCOL || stored.target !== rawTarget || !PHASES.has(stored.phase)) throw new Error('production qualification state is unavailable for finalization');
    let record = normalizeRecord(stored, rawTarget, stored.expectedDigest);
    if (record.phase === 'finalized') return Object.freeze({ protocol: WINDOWS_PRODUCTION_FINALIZATION_PROTOCOL, finalized: true, sanitized: true });
    if (record.phase === 'finalization-attempted') throw new Error('production finalization effect is ambiguous and cannot be replayed');
    if (!['qualified', 'finalization-requested'].includes(record.phase)) throw new Error('production image is not qualified for finalization');
    if (record.phase === 'qualified') {
      record = await this.#save(record, 'finalization-attempted');
      const result = normalizeOperationResult(await this.#execute(rawTarget, 'finalize-v1', 60_000), new Set(['scheduled', 'processId']), 'production finalization result');
      if (result.scheduled !== true || !Number.isSafeInteger(result.processId) || result.processId < 1) throw new Error('production finalization was not scheduled');
      record = await this.#save(record, 'finalization-requested');
    }
    await this.#waitForOff(rawTarget);
    await this.#save(record, 'finalized');
    return Object.freeze({ protocol: WINDOWS_PRODUCTION_FINALIZATION_PROTOCOL, finalized: true, sanitized: true });
  }
}

export function createWindowsProductionQualification(options) {
  return new WindowsProductionQualification(options);
}
