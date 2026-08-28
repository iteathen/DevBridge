import path from 'node:path';
import process from 'node:process';
import {
  DEFINITION_OBSERVATION_PROTOCOL,
  DEFINITION_RECONCILIATION_PROTOCOL,
  reconcileDefinition,
} from './definition-reconciliation.js';
import {
  LINUX_PROTECTED_STORAGE_PROTOCOL,
  inspectLinuxProtectedEntry,
  readLinuxProtectedFile,
  writeLinuxProtectedFile,
} from './linux-protected-storage.js';
import {
  LINUX_SERVICE_MANAGER_PROTOCOL,
  createLinuxServiceManager,
} from './linux-service-manager.js';
import {
  LINUX_SERVICE_OBSERVATION_PROTOCOL,
  observeLinuxService,
} from './linux-service-observation.js';

const PROTOCOL = 'devbridge/linux-service-definition-v1';
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,126}\.service$/u;
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const TYPE = /^[a-z][a-z0-9-]{0,30}$/u;
const MAX_DEFINITION_BYTES = 64 * 1024;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function boundedText(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_DEFINITION_BYTES) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function localName(value, name) {
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function normalizedRequest(value) {
  exactKeys(value, new Set(['name', 'path', 'definition', 'acceptedDefinitions', 'expected', 'platform', 'signal']), 'Linux service definition request');
  const platform = value.platform ?? process.platform;
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('Linux service definition platform is invalid');
  if (platform !== 'linux') return Object.freeze({ platform });
  if (typeof value.name !== 'string' || !UNIT.test(value.name)) throw new TypeError('Linux service definition name is invalid');
  if (typeof value.path !== 'string' || value.path.length > 4_096 || /[\0\r\n]/u.test(value.path)
      || !path.posix.isAbsolute(value.path) || path.posix.resolve(value.path) !== value.path || path.posix.basename(value.path) !== value.name) {
    throw new TypeError('Linux service definition path is invalid');
  }
  const definition = boundedText(value.definition, 'Linux service definition bytes');
  const accepted = value.acceptedDefinitions ?? [];
  if (!Array.isArray(accepted) || accepted.length > 2) throw new TypeError('Linux service accepted definitions are invalid');
  const acceptedDefinitions = accepted.map((entry) => boundedText(entry, 'Linux service accepted definition'));
  if (new Set([definition, ...acceptedDefinitions]).size !== acceptedDefinitions.length + 1) {
    throw new TypeError('Linux service accepted definitions are ambiguous');
  }
  exactKeys(value.expected, new Set(['user', 'group', 'supplementaryGroups', 'type']), 'Linux service expected definition');
  if (!Array.isArray(value.expected.supplementaryGroups) || value.expected.supplementaryGroups.length > 8) {
    throw new TypeError('Linux service expected supplementary groups are invalid');
  }
  const supplementaryGroups = value.expected.supplementaryGroups.map((entry) => localName(entry, 'Linux service expected supplementary group'));
  if (new Set(supplementaryGroups).size !== supplementaryGroups.length) throw new TypeError('Linux service expected supplementary groups are ambiguous');
  if (typeof value.expected.type !== 'string' || !TYPE.test(value.expected.type)) throw new TypeError('Linux service expected type is invalid');
  const signal = value.signal ?? null;
  if (signal != null && (typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('Linux service definition cancellation signal is invalid');
  }
  return Object.freeze({
    platform: 'linux',
    name: value.name,
    path: value.path,
    definition,
    acceptedDefinitions: Object.freeze(acceptedDefinitions),
    expected: Object.freeze({
      user: localName(value.expected.user, 'Linux service expected user'),
      group: localName(value.expected.group, 'Linux service expected group'),
      supplementaryGroups: Object.freeze(supplementaryGroups),
      type: value.expected.type,
    }),
    signal,
  });
}

function normalizedPorts(value) {
  exactKeys(value, new Set(['inspect', 'load', 'save', 'observe', 'actions', 'reconcile']), 'Linux service definition ports');
  const selected = Object.freeze({
    inspect: value.inspect ?? inspectLinuxProtectedEntry,
    load: value.load ?? readLinuxProtectedFile,
    save: value.save ?? writeLinuxProtectedFile,
    observe: value.observe ?? observeLinuxService,
    actions: value.actions ?? createLinuxServiceManager,
    reconcile: value.reconcile ?? reconcileDefinition,
  });
  for (const [name, port] of Object.entries(selected)) if (typeof port !== 'function') throw new TypeError(`Linux service definition ${name} port is invalid`);
  return selected;
}

function readyFile(value, selected) {
  exactKeys(value, new Set(['protocol', 'path', 'exists', 'kind', 'owner', 'group', 'mode', 'observedMode']), 'Linux service definition file observation');
  if (value.protocol !== LINUX_PROTECTED_STORAGE_PROTOCOL || value.path !== selected.path
      || !['exists', 'kind', 'owner', 'group', 'mode'].every((name) => typeof value[name] === 'boolean')
      || !(value.observedMode === null || (Number.isSafeInteger(value.observedMode) && value.observedMode >= 0 && value.observedMode <= 0o7777))) {
    throw new Error('Linux service definition file observation is invalid');
  }
  if (!value.exists) {
    if (value.kind || value.owner || value.group || value.mode || value.observedMode !== null) {
      throw new Error('Linux service definition absent file observation is invalid');
    }
    return false;
  }
  if (!(value.kind && value.owner && value.group && value.mode)) throw new Error('Linux service definition file policy is invalid');
  return true;
}

function normalizedService(value) {
  const keys = new Set([
    'protocol', 'platform', 'applicable', 'observable', 'exists', 'reason', 'loadState', 'activeState', 'subState',
    'mainPid', 'fragmentPath', 'user', 'group', 'supplementaryGroups', 'type', 'unitFileState', 'needsReload',
    'dropIns', 'definitionCurrent',
  ]);
  exactKeys(value, keys, 'Linux service definition observation');
  if (value.protocol !== LINUX_SERVICE_OBSERVATION_PROTOCOL || value.platform !== 'linux' || value.applicable !== true
      || typeof value.observable !== 'boolean' || typeof value.exists !== 'boolean' || typeof value.needsReload !== 'boolean'
      || typeof value.dropIns !== 'boolean' || typeof value.definitionCurrent !== 'boolean' || !Array.isArray(value.supplementaryGroups)) {
    throw new Error('Linux service definition observation is invalid');
  }
  if (!value.observable) throw new Error('Linux service definition is not observable');
  if (value.definitionCurrent !== (!value.needsReload && !value.dropIns)) throw new Error('Linux service definition observation is invalid');
  if (value.reason !== null) throw new Error('Linux service definition observation is invalid');
  for (const name of ['loadState', 'activeState', 'subState', 'fragmentPath', 'user', 'group', 'type', 'unitFileState']) {
    if (typeof value[name] !== 'string') throw new Error('Linux service definition observation is invalid');
  }
  if (!Number.isSafeInteger(value.mainPid) || value.mainPid < 0
      || value.supplementaryGroups.length > 8
      || value.supplementaryGroups.some((entry) => typeof entry !== 'string' || !LOCAL_NAME.test(entry))
      || new Set(value.supplementaryGroups).size !== value.supplementaryGroups.length
      || value.exists !== (value.loadState !== 'not-found')) {
    throw new Error('Linux service definition observation is invalid');
  }
  if (!value.exists && (value.fragmentPath !== '' || value.user !== '' || value.group !== ''
      || value.supplementaryGroups.length !== 0 || value.type !== '' || value.mainPid !== 0)) {
    throw new Error('Linux service definition absent observation contains loaded identity');
  }
  return Object.freeze({ ...value, supplementaryGroups: Object.freeze([...value.supplementaryGroups]) });
}

function normalizedActions(value) {
  exactKeys(value, new Set(['protocol', 'platform', 'applicable', 'refresh', 'persist', 'quiesce', 'activate']), 'Linux service definition actions');
  if (value.protocol !== LINUX_SERVICE_MANAGER_PROTOCOL || value.platform !== 'linux' || value.applicable !== true
      || typeof value.refresh !== 'function' || typeof value.persist !== 'function'
      || typeof value.quiesce !== 'function' || typeof value.activate !== 'function') {
    throw new Error('Linux service definition actions are invalid');
  }
  return value;
}

export async function reconcileLinuxServiceDefinition(value = {}, providedPorts = {}) {
  const selected = normalizedRequest(value);
  if (selected.platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform: selected.platform, applicable: false });
  const ports = normalizedPorts(providedPorts);
  const contract = Object.freeze({ path: selected.path, ownerId: 0, groupId: 0, mode: 0o644 });
  const parent = Object.freeze({ path: path.posix.dirname(selected.path), ownerId: 0, groupId: 0, mode: null });
  const admitted = new Set([selected.definition, ...selected.acceptedDefinitions]);
  const manager = normalizedActions(ports.actions({ unit: selected.name, platform: 'linux', signal: selected.signal }));

  async function fileContent() {
    const observed = await ports.inspect({ contract, kind: 'file' });
    if (!readyFile(observed, selected)) return null;
    const loaded = await ports.load({ contract, maximumBytes: MAX_DEFINITION_BYTES });
    exactKeys(loaded, new Set(['protocol', 'content', 'size']), 'Linux service definition file content');
    if (loaded.protocol !== LINUX_PROTECTED_STORAGE_PROTOCOL || !Buffer.isBuffer(loaded.content)
        || loaded.size !== loaded.content.length) {
      throw new Error('Linux service definition file content is invalid');
    }
    const content = loaded.content.toString('utf8');
    if (!admitted.has(content)) throw new Error('Linux service definition contains unadmitted bytes');
    return content;
  }

  async function observation() {
    const [content, service] = await Promise.all([
      fileContent(),
      ports.observe({ unit: selected.name, platform: 'linux', signal: selected.signal }).then(normalizedService),
    ]);
    if (service.exists && service.fragmentPath !== selected.path) throw new Error('Linux service definition fragment is foreign');
    if (service.exists && (service.user !== selected.expected.user
        || service.group !== selected.expected.group
        || !sameSet(service.supplementaryGroups, selected.expected.supplementaryGroups)
        || service.type !== selected.expected.type)) {
      throw new Error('Linux service definition loaded identity is foreign');
    }
    if (service.dropIns) throw new Error('Linux service definition has loaded drop-ins');
    const stored = content === selected.definition;
    return Object.freeze({
      protocol: DEFINITION_OBSERVATION_PROTOCOL,
      stored,
      current: stored && service.exists && service.definitionCurrent,
      persistent: service.unitFileState === 'enabled',
    });
  }

  const result = await ports.reconcile({
    definition: selected.definition,
    ports: Object.freeze({
      observe: observation,
      async publish() {
        const content = await fileContent();
        if (content === selected.definition) throw new Error('Linux service definition publication is already complete');
        const saved = await ports.save({
          contract,
          parent,
          content: Buffer.from(selected.definition, 'utf8'),
          maximumBytes: MAX_DEFINITION_BYTES,
        });
        exactKeys(saved, new Set(['protocol', 'path', 'exists', 'kind', 'owner', 'group', 'mode', 'observedMode', 'changed']), 'Linux service definition publication evidence');
        if (saved.protocol !== LINUX_PROTECTED_STORAGE_PROTOCOL || saved.path !== selected.path || saved.changed !== true
            || !(saved.exists && saved.kind && saved.owner && saved.group && saved.mode)) {
          throw new Error('Linux service definition publication evidence is invalid');
        }
        return true;
      },
      refresh: () => manager.refresh(),
      persist: () => manager.persist(),
    }),
  });
  exactKeys(result, new Set(['protocol', 'ready', 'changed']), 'Linux service definition reconciliation evidence');
  if (result.protocol !== DEFINITION_RECONCILIATION_PROTOCOL || result.ready !== true || typeof result.changed !== 'boolean') {
    throw new Error('Linux service definition reconciliation evidence is invalid');
  }
  return Object.freeze({ protocol: PROTOCOL, platform: 'linux', applicable: true, ready: true, changed: result.changed });
}

export { PROTOCOL as LINUX_SERVICE_DEFINITION_PROTOCOL };
