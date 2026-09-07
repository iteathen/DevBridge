import path from 'node:path';
import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/linux-service-observation-v1';
const SYSTEMCTL = '/usr/bin/systemctl';
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,126}\.service$/u;
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const NUMERIC_GROUP_SELECTOR = /^[1-9][0-9]{0,9}$/u;
const MAX_LOCAL_ID = 0xffff_fffe;
const TOKEN = /^[a-z][a-z0-9-]{0,63}$/u;
const ENVIRONMENT = Object.freeze({ LANG: 'C', LC_ALL: 'C' });
const PROPERTIES = Object.freeze([
  'LoadState',
  'ActiveState',
  'SubState',
  'MainPID',
  'FragmentPath',
  'User',
  'Group',
  'SupplementaryGroups',
  'Type',
  'UnitFileState',
  'NeedDaemonReload',
  'DropInPaths',
]);

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function unitName(value) {
  if (typeof value !== 'string' || !UNIT.test(value)) throw new TypeError('Linux service observation unit is invalid');
  return value;
}

function cancellation(value) {
  if (value == null) return null;
  if (typeof value !== 'object'
      || typeof value.aborted !== 'boolean'
      || typeof value.addEventListener !== 'function'
      || typeof value.removeEventListener !== 'function') {
    throw new TypeError('Linux service observation cancellation signal is invalid');
  }
  return value;
}

function succeeded(value) {
  return value?.exitCode === 0
    && value?.timedOut !== true
    && value?.aborted !== true
    && value?.outputTruncated !== true;
}

function safeToken(value, name, { empty = false } = {}) {
  if (empty && value === '') return '';
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`Linux service observation ${name} is invalid`);
  return value;
}

function localName(value, name, { empty = false } = {}) {
  if (empty && value === '') return '';
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) throw new Error(`Linux service observation ${name} is invalid`);
  return value;
}

function groupSelector(value, name) {
  if (typeof value !== 'string') throw new Error(`Linux service observation ${name} is invalid`);
  if (LOCAL_NAME.test(value)) return value;
  if (!NUMERIC_GROUP_SELECTOR.test(value) || Number(value) > MAX_LOCAL_ID) {
    throw new Error(`Linux service observation ${name} is invalid`);
  }
  return value;
}

function absolutePath(value, name, { empty = false } = {}) {
  if (empty && value === '') return '';
  if (typeof value !== 'string' || value.length > 4_096 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value) {
    throw new Error(`Linux service observation ${name} is invalid`);
  }
  return value;
}

function numeric(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/u.test(value)) throw new Error('Linux service observation pid is invalid');
  const selected = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(selected) || selected < 0) throw new Error('Linux service observation pid is invalid');
  return selected;
}

function parsedProperties(stdout) {
  const values = new Map();
  const lines = String(stdout ?? '').replaceAll('\r\n', '\n').split('\n').filter((line) => line.length > 0);
  if (lines.length !== PROPERTIES.length) throw new Error('Linux service observation is incomplete');
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('Linux service observation is invalid');
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (!PROPERTIES.includes(key) || values.has(key) || /[\0\r]/u.test(value)) throw new Error('Linux service observation is invalid');
    values.set(key, value);
  }
  return values;
}

function unavailable(platform, reason) {
  return Object.freeze({
    protocol: PROTOCOL,
    platform,
    applicable: platform === 'linux',
    observable: false,
    exists: false,
    reason,
    loadState: '',
    activeState: '',
    subState: '',
    mainPid: 0,
    fragmentPath: '',
    user: '',
    group: '',
    supplementaryGroups: Object.freeze([]),
    type: '',
    unitFileState: '',
    needsReload: false,
    dropIns: false,
    definitionCurrent: false,
  });
}

export async function observeLinuxService(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['unit', 'platform', 'signal']), 'Linux service observation request');
  exactKeys(providedPorts, new Set(['invoke']), 'Linux service observation ports');
  const platform = value.platform ?? process.platform;
  if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('Linux service observation platform is invalid');
  if (platform !== 'linux') return unavailable(platform, 'not applicable');
  const unit = unitName(value.unit);
  const signal = cancellation(value.signal);
  const invoke = providedPorts.invoke ?? invokeCommand;
  if (typeof invoke !== 'function') throw new TypeError('Linux service observation invocation port is invalid');

  let result;
  try {
    result = await invoke({
      executable: SYSTEMCTL,
      arguments: [
        '--system',
        '--no-pager',
        '--no-ask-password',
        'show',
        unit,
        ...PROPERTIES.map((property) => `--property=${property}`),
      ],
      input: null,
      timeoutMs: 15_000,
      maxOutputBytes: 32 * 1024,
      environment: ENVIRONMENT,
      signal,
    });
  } catch {
    return unavailable('linux', 'service manager observation unavailable');
  }
  if (!succeeded(result)) return unavailable('linux', 'service manager observation failed');

  let values;
  try { values = parsedProperties(result.stdout); }
  catch { return unavailable('linux', 'service manager observation invalid'); }
  try {
    const loadState = safeToken(values.get('LoadState'), 'load state');
    const exists = loadState !== 'not-found';
    const supplementaryGroups = values.get('SupplementaryGroups').split(/\s+/u).filter(Boolean).map((entry) => groupSelector(entry, 'supplementary group'));
    if (new Set(supplementaryGroups).size !== supplementaryGroups.length) throw new Error('Linux service observation supplementary groups are ambiguous');
    const reload = values.get('NeedDaemonReload');
    if (!['yes', 'no'].includes(reload)) throw new Error('Linux service observation reload state is invalid');
    const dropIns = values.get('DropInPaths').trim().length > 0;
    return Object.freeze({
      protocol: PROTOCOL,
      platform: 'linux',
      applicable: true,
      observable: true,
      exists,
      reason: null,
      loadState,
      activeState: safeToken(values.get('ActiveState'), 'active state'),
      subState: safeToken(values.get('SubState'), 'substate'),
      mainPid: numeric(values.get('MainPID')),
      fragmentPath: absolutePath(values.get('FragmentPath'), 'fragment path', { empty: !exists }),
      user: localName(values.get('User'), 'user', { empty: !exists }),
      group: localName(values.get('Group'), 'group', { empty: !exists }),
      supplementaryGroups: Object.freeze(supplementaryGroups),
      type: safeToken(values.get('Type'), 'type', { empty: !exists }),
      unitFileState: safeToken(values.get('UnitFileState'), 'unit file state', { empty: !exists }),
      needsReload: reload === 'yes',
      dropIns,
      definitionCurrent: reload === 'no' && !dropIns,
    });
  } catch {
    return unavailable('linux', 'service manager observation invalid');
  }
}

export { PROTOCOL as LINUX_SERVICE_OBSERVATION_PROTOCOL };
