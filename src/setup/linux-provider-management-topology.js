import { lstat } from 'node:fs/promises';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/linux-provider-management-topology-v1';
const SYSTEMCTL = '/usr/bin/systemctl';
const GETENT = '/usr/bin/getent';
const ENVIRONMENT = Object.freeze({ LANG: 'C', LC_ALL: 'C' });
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const TOKEN = /^[a-z][a-z0-9-]{0,63}$/u;
const UNIT_PROPERTIES = Object.freeze(['LoadState', 'ActiveState', 'NeedDaemonReload']);
const SOCKET_PROPERTIES = Object.freeze([...UNIT_PROPERTIES, 'Listen']);
const LISTENER = /(?:^|\s)(\/[^\s()]*) \((Stream|Datagram|SequentialPacket)\)(?=\s|$)/gu;
const ROUTES = Object.freeze({
  segmented: Object.freeze({
    socket: 'virtqemud.socket',
    service: 'virtqemud.service',
    subject: '/run/libvirt/virtqemud-sock',
  }),
  combined: Object.freeze({
    socket: 'libvirtd.socket',
    service: 'libvirtd.service',
    subject: '/run/libvirt/libvirt-sock',
  }),
});
const COMPATIBILITY = Object.freeze({
  socket: 'virtproxyd.socket',
  service: 'virtproxyd.service',
  subject: '/run/libvirt/libvirt-sock',
});

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function cancellation(value) {
  if (value == null) return null;
  if (typeof value !== 'object'
      || typeof value.aborted !== 'boolean'
      || typeof value.addEventListener !== 'function'
      || typeof value.removeEventListener !== 'function') {
    throw new TypeError('Linux management topology cancellation signal is invalid');
  }
  return value;
}

function succeeded(value) {
  return value?.exitCode === 0
    && value?.timedOut !== true
    && value?.aborted !== true
    && value?.outputTruncated !== true;
}

function unavailable(platform, classification, reason, { observable = false } = {}) {
  return Object.freeze({
    protocol: PROTOCOL,
    platform,
    applicable: platform === 'linux',
    observable,
    exact: false,
    classification,
    route: null,
    selectedCapability: null,
    capabilities: Object.freeze([]),
    subjects: Object.freeze([]),
    reason,
  });
}

function parseProperties(stdout, properties) {
  const values = new Map();
  const lines = String(stdout ?? '').replaceAll('\r\n', '\n').split('\n').filter((line) => line.length > 0);
  if (lines.length !== properties.length) throw new Error('incomplete');
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('invalid');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (!properties.includes(key) || values.has(key) || /[\0\r]/u.test(value) || Buffer.byteLength(value, 'utf8') > 8 * 1024) {
      throw new Error('invalid');
    }
    values.set(key, value);
  }
  return values;
}

function token(value, { empty = false } = {}) {
  if (empty && value === '') return '';
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('invalid');
  return value;
}

function listeners(value) {
  if (value === '') return Object.freeze([]);
  const selected = [];
  let consumed = '';
  for (const match of value.matchAll(LISTENER)) {
    selected.push(Object.freeze({ subject: match[1], kind: match[2].toLowerCase() }));
    consumed += `${consumed.length === 0 ? '' : ' '}${match[1]} (${match[2]})`;
  }
  if (selected.length === 0 || consumed !== value) throw new Error('invalid');
  return Object.freeze(selected);
}

async function observeUnit(definition, { invoke, environment, signal }) {
  const socket = definition.endsWith('.socket');
  const properties = socket ? SOCKET_PROPERTIES : UNIT_PROPERTIES;
  let result;
  try {
    result = await invoke({
      executable: SYSTEMCTL,
      arguments: [
        '--system',
        '--no-pager',
        '--no-ask-password',
        'show',
        definition,
        ...properties.map((property) => `--property=${property}`),
      ],
      input: null,
      timeoutMs: 15_000,
      maxOutputBytes: 32 * 1024,
      environment,
      signal,
    });
  } catch {
    return null;
  }
  if (!succeeded(result)) return null;
  try {
    const values = parseProperties(result.stdout, properties);
    const loadState = token(values.get('LoadState'));
    const exists = loadState !== 'not-found';
    const reload = values.get('NeedDaemonReload');
    if (!['yes', 'no'].includes(reload)) throw new Error('invalid');
    return Object.freeze({
      exists,
      active: exists && token(values.get('ActiveState')) === 'active',
      current: reload === 'no',
      listeners: socket ? listeners(values.get('Listen')) : Object.freeze([]),
    });
  } catch {
    return null;
  }
}

function active(pair) {
  return pair.socket.active || pair.service.active;
}

function activeCurrent(pair) {
  return (!pair.socket.active || pair.socket.current) && (!pair.service.active || pair.service.current);
}

function exactListener(pair, subject) {
  if (!pair.socket.active) return true;
  return pair.socket.listeners.length === 1
    && pair.socket.listeners[0].kind === 'stream'
    && pair.socket.listeners[0].subject === subject;
}

async function optionalStat(subject, stat) {
  try { return await stat(subject); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function surfacePolicy(info) {
  if (info == null) return null;
  if (typeof info.isSocket !== 'function' || typeof info.isSymbolicLink !== 'function'
      || !info.isSocket() || info.isSymbolicLink() || info.uid !== 0
      || !Number.isSafeInteger(info.gid) || info.gid < 0 || !Number.isSafeInteger(info.mode)) return 'invalid';
  const mode = info.mode & 0o777;
  if ((mode & 0o007) !== 0) return 'policy-backed';
  if (info.gid > 0 && (mode & 0o660) === 0o660) return 'group-only';
  if ((mode & 0o600) === 0o600) return 'root-only';
  return 'invalid';
}

async function groupFor(gid, { invoke, environment, signal }) {
  let result;
  try {
    result = await invoke({
      executable: GETENT,
      arguments: ['group', String(gid)],
      input: null,
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024,
      environment,
      signal,
    });
  } catch {
    return null;
  }
  if (!succeeded(result)) return null;
  const lines = String(result.stdout ?? '').trim().split('\n').filter(Boolean);
  if (lines.length !== 1 || /[\0\r]/u.test(lines[0])) return null;
  const fields = lines[0].split(':');
  if (fields.length !== 4 || !LOCAL_NAME.test(fields[0]) || fields[2] !== String(gid)) return null;
  return Object.freeze({ name: fields[0], id: gid });
}

function publicSubject(role, policy, capability) {
  return Object.freeze({ role, policy, capability });
}

function classificationFor(subjects) {
  const policies = new Set(subjects.map((entry) => entry.policy));
  return policies.size === 1 ? subjects[0].policy : 'mixed';
}

export async function observeLinuxProviderManagementTopology(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['platform', 'signal']), 'Linux management topology request');
  exactKeys(providedPorts, new Set(['invoke', 'stat']), 'Linux management topology ports');
  const platform = value.platform ?? process.platform;
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('Linux management topology platform is invalid');
  if (platform !== 'linux') return unavailable(platform, 'not-applicable', 'not-applicable');
  const signal = cancellation(value.signal);
  const invoke = providedPorts.invoke ?? invokeCommand;
  const stat = providedPorts.stat ?? lstat;
  if (typeof invoke !== 'function' || typeof stat !== 'function') throw new TypeError('Linux management topology ports are invalid');
  const context = { invoke, environment: ENVIRONMENT, signal };

  const definitions = [
    ROUTES.segmented.socket,
    ROUTES.segmented.service,
    ROUTES.combined.socket,
    ROUTES.combined.service,
    COMPATIBILITY.socket,
    COMPATIBILITY.service,
  ];
  const observed = await Promise.all(definitions.map((definition) => observeUnit(definition, context)));
  if (observed.some((entry) => entry == null)) return unavailable('linux', 'unavailable', 'observation-unavailable');
  const byName = new Map(definitions.map((definition, index) => [definition, observed[index]]));
  const segmented = Object.freeze({ socket: byName.get(ROUTES.segmented.socket), service: byName.get(ROUTES.segmented.service) });
  const combined = Object.freeze({ socket: byName.get(ROUTES.combined.socket), service: byName.get(ROUTES.combined.service) });
  const compatibility = Object.freeze({ socket: byName.get(COMPATIBILITY.socket), service: byName.get(COMPATIBILITY.service) });
  const segmentedActive = active(segmented);
  const combinedActive = active(combined);
  const compatibilityActive = active(compatibility);

  if (segmentedActive && combinedActive) return unavailable('linux', 'ambiguous', 'conflicting-active-routes', { observable: true });
  if (!segmentedActive && !combinedActive) {
    return unavailable('linux', compatibilityActive ? 'invalid' : 'unavailable', compatibilityActive ? 'orphaned-compatibility-route' : 'no-active-route', { observable: true });
  }
  if (combinedActive && compatibilityActive) return unavailable('linux', 'ambiguous', 'conflicting-active-routes', { observable: true });

  const route = segmentedActive ? 'segmented' : 'combined';
  const selected = route === 'segmented' ? segmented : combined;
  const selectedDefinition = ROUTES[route];
  const activePairs = compatibilityActive ? [selected, compatibility] : [selected];
  if (!selected.socket.active || (compatibilityActive && !compatibility.socket.active)) {
    return unavailable('linux', 'invalid', 'unsupported-activation', { observable: true });
  }
  if (activePairs.some((pair) => !activeCurrent(pair))) {
    return unavailable('linux', 'invalid', 'active-definition-stale', { observable: true });
  }
  if (!exactListener(selected, selectedDefinition.subject)
      || (compatibilityActive && !exactListener(compatibility, COMPATIBILITY.subject))) {
    return unavailable('linux', 'invalid', 'unexpected-listener', { observable: true });
  }

  let directInfo;
  let compatibilityInfo;
  try {
    [directInfo, compatibilityInfo] = await Promise.all([
      optionalStat(ROUTES.segmented.subject, stat),
      optionalStat(ROUTES.combined.subject, stat),
    ]);
  } catch {
    return unavailable('linux', 'unavailable', 'surface-observation-unavailable');
  }
  if ((route === 'segmented' && directInfo == null) || (route === 'combined' && compatibilityInfo == null)
      || (compatibilityActive && compatibilityInfo == null)) {
    return unavailable('linux', 'invalid', 'missing-active-surface', { observable: true });
  }
  if ((route === 'combined' && directInfo != null)
      || (route === 'segmented' && !compatibilityActive && compatibilityInfo != null)) {
    return unavailable('linux', 'invalid', 'unexplained-surface', { observable: true });
  }

  const rawSubjects = route === 'segmented'
    ? [{ role: 'primary', info: directInfo }, ...(compatibilityActive ? [{ role: 'compatibility', info: compatibilityInfo }] : [])]
    : [{ role: 'primary', info: compatibilityInfo }];
  const policies = rawSubjects.map((entry) => Object.freeze({ ...entry, policy: surfacePolicy(entry.info) }));
  if (policies.some((entry) => entry.policy === 'invalid')) {
    return unavailable('linux', 'invalid', 'invalid-surface', { observable: true });
  }

  const groupIds = [...new Set(policies.filter((entry) => entry.policy === 'group-only').map((entry) => entry.info.gid))];
  const groups = await Promise.all(groupIds.map((gid) => groupFor(gid, context)));
  if (groups.some((entry) => entry == null)) return unavailable('linux', 'invalid', 'identity-unavailable', { observable: true });
  const groupById = new Map(groups.map((entry) => [entry.id, entry]));
  const subjects = Object.freeze(policies.map((entry) => publicSubject(
    entry.role,
    entry.policy,
    entry.policy === 'group-only' ? groupById.get(entry.info.gid) : null,
  )));
  const classification = classificationFor(subjects);
  const capabilities = Object.freeze([...groupById.values()].sort((left, right) => left.id - right.id));
  const selectedCapability = classification === 'group-only' ? subjects.find((entry) => entry.role === 'primary')?.capability ?? null : null;
  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    observable: true,
    exact: true,
    classification,
    route,
    selectedCapability,
    capabilities,
    subjects,
    reason: null,
  });
}

export { PROTOCOL as LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL };
