import path from 'node:path';
import process from 'node:process';
import {
  applyLinuxDirectoryDefinition,
} from './linux-directory-definition-applicator.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL,
} from './linux-lifecycle-authority.js';
import {
  normalizeLinuxLifecycleAuthorityOwnershipRecord,
} from './linux-lifecycle-authority-records.js';
import {
  LINUX_PROTECTED_STORAGE_PROTOCOL,
  inspectLinuxProtectedEntry,
  readLinuxProtectedFile,
  writeLinuxProtectedFile,
} from './linux-protected-storage.js';

const PROTOCOL = 'devbridge/linux-lifecycle-authority-endpoint-topology-v1';
const DEFINITION_DIRECTORY = '/etc/tmpfiles.d';
const MAX_DEFINITION_BYTES = 64 * 1024;
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const DEFINITION_NAME = /^devbridge-lifecycle-authority-[0-9a-f]{12}\.conf$/u;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function cancellationSignal(value) {
  const signal = value ?? null;
  if (signal != null && (typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('Linux lifecycle authority endpoint topology cancellation signal is invalid');
  }
  return signal;
}

function boundedDefinition(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > MAX_DEFINITION_BYTES) {
    throw new TypeError('Linux lifecycle authority endpoint definition is invalid');
  }
  return value;
}

function localName(value) {
  return typeof value === 'string' && LOCAL_NAME.test(value);
}

function endpointPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096
    && !/[\\%\s\0\r\n]/u.test(value)
    && path.posix.isAbsolute(value)
    && path.posix.resolve(value) === value;
}

function expectedDefinition(value) {
  return [
    `d ${value.endpoints.parentDirectory} 0755 root root -`,
    `d ${value.endpoints.runRoot} 0755 root root -`,
    `d ${value.endpoints.read.directory} 0750 ${value.endpoints.read.directoryOwner} ${value.endpoints.read.directoryGroup} -`,
    `d ${value.endpoints.mutation.directory} 0700 ${value.endpoints.mutation.directoryOwner} ${value.endpoints.mutation.directoryGroup} -`,
    '',
  ].join('\n');
}

function exactPlan(value) {
  if (!value || value.protocol !== LINUX_LIFECYCLE_AUTHORITY_PLAN_PROTOCOL) {
    throw new TypeError('Linux lifecycle authority endpoint topology plan is invalid');
  }
  const definition = value.endpoints?.definition;
  const read = value.endpoints?.read;
  const mutation = value.endpoints?.mutation;
  if (!definition || !read || !mutation
      || !endpointPath(value.endpoints.parentDirectory)
      || !value.endpoints.parentDirectory.startsWith('/run/')
      || !endpointPath(value.endpoints.runRoot)
      || !endpointPath(read.directory) || !endpointPath(mutation.directory)
      || !endpointPath(read.endpoint) || !endpointPath(mutation.endpoint)
      || typeof value.authorityIdentity !== 'string'
      || !/^[0-9a-f]{32}$/u.test(value.authorityIdentity)
      || definition.name !== `devbridge-lifecycle-authority-${value.authorityIdentity.slice(0, 12)}.conf`
      || !DEFINITION_NAME.test(definition.name)
      || path.posix.dirname(definition.path ?? '') !== DEFINITION_DIRECTORY
      || path.posix.basename(definition.path) !== definition.name
      || path.posix.dirname(value.endpoints.runRoot ?? '') !== value.endpoints.parentDirectory
      || path.posix.dirname(read.directory ?? '') !== value.endpoints.runRoot
      || path.posix.dirname(mutation.directory ?? '') !== value.endpoints.runRoot
      || path.posix.dirname(read.endpoint ?? '') !== read.directory
      || path.posix.dirname(mutation.endpoint ?? '') !== mutation.directory
      || read.directoryOwner !== value.service?.user
      || read.directoryGroup !== value.service?.readGroup
      || mutation.directoryOwner !== value.service?.user
      || mutation.directoryGroup !== 'root'
      || read.socketOwner !== value.service?.user
      || mutation.socketOwner !== value.service?.user
      || read.socketGroup !== value.service?.readGroup
      || mutation.socketGroup !== value.service?.readGroup
      || !localName(value.service?.user) || !localName(value.service?.readGroup)
      || read.directoryMode !== 0o750 || mutation.directoryMode !== 0o700
      || read.socketMode !== 0o770 || mutation.socketMode !== 0o770
      || value.access?.volatileDefinition?.mode !== 0o644) {
    throw new TypeError('Linux lifecycle authority endpoint topology plan is invalid');
  }
  boundedDefinition(definition.content);
  if (definition.content !== expectedDefinition(value)) throw new TypeError('Linux lifecycle authority endpoint topology plan is invalid');
  return value;
}

function normalizedPorts(value) {
  exactKeys(value, new Set(['state', 'inspect', 'load', 'save', 'apply']), 'Linux lifecycle authority endpoint topology ports');
  exactKeys(value.state, new Set(['load']), 'Linux lifecycle authority endpoint topology state port');
  const selected = Object.freeze({
    state: value.state,
    inspect: value.inspect ?? inspectLinuxProtectedEntry,
    load: value.load ?? readLinuxProtectedFile,
    save: value.save ?? writeLinuxProtectedFile,
    apply: value.apply ?? applyLinuxDirectoryDefinition,
  });
  for (const [name, port] of Object.entries({
    stateLoad: selected.state.load,
    inspect: selected.inspect,
    load: selected.load,
    save: selected.save,
    apply: selected.apply,
  })) {
    if (typeof port !== 'function') throw new TypeError(`Linux lifecycle authority endpoint topology ${name} port is invalid`);
  }
  return selected;
}

function entryEvidence(value, contract, name) {
  exactKeys(value, new Set(['protocol', 'path', 'exists', 'kind', 'owner', 'group', 'mode', 'observedMode']), `${name} observation`);
  if (value.protocol !== LINUX_PROTECTED_STORAGE_PROTOCOL || value.path !== contract.path
      || !['exists', 'kind', 'owner', 'group', 'mode'].every((key) => typeof value[key] === 'boolean')
      || !(value.observedMode === null || (Number.isSafeInteger(value.observedMode) && value.observedMode >= 0 && value.observedMode <= 0o7777))) {
    throw new Error(`${name} observation is invalid`);
  }
  if (!value.exists) {
    if (value.kind || value.owner || value.group || value.mode || value.observedMode !== null) {
      throw new Error(`${name} absent observation is invalid`);
    }
    return false;
  }
  if (!(value.kind && value.owner && value.group && value.mode)) throw new Error(`${name} policy is invalid`);
  return true;
}

function fileContent(value) {
  exactKeys(value, new Set(['protocol', 'content', 'size']), 'Linux lifecycle authority endpoint definition content');
  if (value.protocol !== LINUX_PROTECTED_STORAGE_PROTOCOL || !Buffer.isBuffer(value.content)
      || value.size !== value.content.length || value.size < 1 || value.size > MAX_DEFINITION_BYTES) {
    throw new Error('Linux lifecycle authority endpoint definition content is invalid');
  }
  return value.content.toString('utf8');
}

function savedDefinition(value, contract) {
  exactKeys(value, new Set(['protocol', 'path', 'exists', 'kind', 'owner', 'group', 'mode', 'observedMode', 'changed']), 'Linux lifecycle authority endpoint definition publication');
  if (value.protocol !== LINUX_PROTECTED_STORAGE_PROTOCOL || value.path !== contract.path || value.changed !== true
      || !(value.exists && value.kind && value.owner && value.group && value.mode)) {
    throw new Error('Linux lifecycle authority endpoint definition publication is invalid');
  }
}

function applicationEvidence(value) {
  if (value !== true) throw new Error('Linux lifecycle authority endpoint definition application is invalid');
}

function contracts(plan, identity) {
  return Object.freeze({
    definitionParent: Object.freeze({ path: DEFINITION_DIRECTORY, ownerId: 0, groupId: 0, mode: null }),
    definition: Object.freeze({ path: plan.endpoints.definition.path, ownerId: 0, groupId: 0, mode: plan.access.volatileDefinition.mode }),
    directories: Object.freeze([
      Object.freeze({ name: 'Linux lifecycle authority endpoint parent', contract: Object.freeze({ path: plan.endpoints.parentDirectory, ownerId: 0, groupId: 0, mode: 0o755 }) }),
      Object.freeze({ name: 'Linux lifecycle authority endpoint root', contract: Object.freeze({ path: plan.endpoints.runRoot, ownerId: 0, groupId: 0, mode: 0o755 }) }),
      Object.freeze({ name: 'Linux lifecycle authority read endpoint directory', contract: Object.freeze({ path: plan.endpoints.read.directory, ownerId: identity.serviceUid, groupId: identity.readGid, mode: plan.endpoints.read.directoryMode }) }),
      Object.freeze({ name: 'Linux lifecycle authority mutation endpoint directory', contract: Object.freeze({ path: plan.endpoints.mutation.directory, ownerId: identity.serviceUid, groupId: 0, mode: plan.endpoints.mutation.directoryMode }) }),
    ]),
  });
}

export async function reconcileLinuxLifecycleAuthorityEndpointTopology(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['plan', 'platform', 'signal']), 'Linux lifecycle authority endpoint topology request');
  const platform = value.platform ?? process.platform;
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('Linux lifecycle authority endpoint topology platform is invalid');
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false });
  const plan = exactPlan(value.plan);
  const signal = cancellationSignal(value.signal);
  const ports = normalizedPorts(providedPorts);
  const loadedClaim = await ports.state.load();
  if (loadedClaim == null) throw new Error('Linux lifecycle authority endpoint topology requires an established ownership claim');
  const claim = normalizeLinuxLifecycleAuthorityOwnershipRecord(loadedClaim, plan);
  if (claim.localIdentity == null) throw new Error('Linux lifecycle authority endpoint topology requires immutable numeric identity');
  const selected = contracts(plan, claim.localIdentity);

  const parentObserved = await ports.inspect({ contract: selected.definitionParent, kind: 'directory' });
  if (!entryEvidence(parentObserved, selected.definitionParent, 'Linux lifecycle authority endpoint definition parent')) {
    throw new Error('Linux lifecycle authority endpoint definition parent is absent');
  }

  async function observeDefinition() {
    const observed = await ports.inspect({ contract: selected.definition, kind: 'file' });
    if (!entryEvidence(observed, selected.definition, 'Linux lifecycle authority endpoint definition')) return false;
    const current = fileContent(await ports.load({ contract: selected.definition, maximumBytes: MAX_DEFINITION_BYTES }));
    if (current !== plan.endpoints.definition.content) throw new Error('Linux lifecycle authority endpoint definition contains unadmitted bytes');
    return true;
  }

  async function observeDirectories() {
    const evidence = [];
    for (const entry of selected.directories) {
      const observed = await ports.inspect({ contract: entry.contract, kind: 'directory' });
      evidence.push(entryEvidence(observed, entry.contract, entry.name));
    }
    return evidence;
  }

  let changed = false;
  if (!await observeDefinition()) {
    const saved = await ports.save({
      contract: selected.definition,
      parent: selected.definitionParent,
      content: Buffer.from(plan.endpoints.definition.content, 'utf8'),
      maximumBytes: MAX_DEFINITION_BYTES,
    });
    savedDefinition(saved, selected.definition);
    if (!await observeDefinition()) throw new Error('Linux lifecycle authority endpoint definition is not observable');
    changed = true;
  }

  let directoryEvidence = await observeDirectories();
  if (directoryEvidence.includes(false)) {
    applicationEvidence(await ports.apply({ path: selected.definition.path, platform: 'linux', signal }));
    directoryEvidence = await observeDirectories();
    if (directoryEvidence.includes(false)) throw new Error('Linux lifecycle authority endpoint directories are not observable');
    changed = true;
  }

  return Object.freeze({ protocol: PROTOCOL, platform: 'linux', applicable: true, ready: true, changed });
}

export { PROTOCOL as LINUX_LIFECYCLE_AUTHORITY_ENDPOINT_TOPOLOGY_PROTOCOL };
