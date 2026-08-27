import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';

const PROTOCOL = 'devbridge/linux-local-identities-v1';
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const GETENT = '/usr/bin/getent';
const ID = '/usr/bin/id';
const MAX_IDENTITIES = 16;

function localName(value, name) {
  if (typeof value !== 'string' || !LOCAL_NAME.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function names(values, name) {
  if (!Array.isArray(values) || values.length > MAX_IDENTITIES) throw new TypeError(`${name} must be a bounded array`);
  const selected = values.map((value) => localName(value, `${name} entry`));
  if (new Set(selected).size !== selected.length) throw new TypeError(`${name} contains a duplicate`);
  return Object.freeze(selected);
}

function unsigned(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

function succeeded(result) {
  return result?.exitCode === 0
    && result?.timedOut !== true
    && result?.aborted !== true
    && result?.outputTruncated !== true;
}

async function invokeLookup(invoke, environment, database, key) {
  const result = await invoke({
    executable: GETENT,
    arguments: [database, key],
    input: null,
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024,
    environment,
  });
  if (result?.exitCode === 2 && String(result.stdout ?? '').trim() === '') return null;
  if (!succeeded(result)) throw new Error(`Linux ${database} identity lookup failed`);
  const lines = String(result.stdout ?? '').trim().split('\n').filter(Boolean);
  if (lines.length !== 1 || /[\0\r]/u.test(lines[0])) throw new Error(`Linux ${database} identity lookup is ambiguous`);
  return lines[0];
}

function accountRecord(line, expectedName) {
  if (line == null) return null;
  const fields = line.split(':');
  if (fields.length !== 7 || fields[0] !== expectedName) throw new Error('Linux account identity lookup returned a mismatched record');
  return Object.freeze({
    name: fields[0],
    uid: unsigned(fields[2], 'Linux account uid'),
    gid: unsigned(fields[3], 'Linux account gid'),
    home: fields[5],
    shell: fields[6],
  });
}

function groupRecord(line, expectedName) {
  if (line == null) return null;
  const fields = line.split(':');
  if (fields.length !== 4 || fields[0] !== expectedName) throw new Error('Linux group identity lookup returned a mismatched record');
  const members = fields[3] === '' ? [] : fields[3].split(',');
  if (members.some((member) => !LOCAL_NAME.test(member)) || new Set(members).size !== members.length) {
    throw new Error('Linux group identity lookup returned invalid membership');
  }
  return Object.freeze({
    name: fields[0],
    gid: unsigned(fields[2], 'Linux group gid'),
    members: Object.freeze(members),
  });
}

async function groupIdsFor(invoke, environment, account) {
  if (account == null) return Object.freeze([]);
  const result = await invoke({
    executable: ID,
    arguments: ['-G', '--', account.name],
    input: null,
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024,
    environment,
  });
  if (!succeeded(result)) throw new Error('Linux account group lookup failed');
  const text = String(result.stdout ?? '').trim();
  if (!/^[0-9]+(?:\s+[0-9]+)*$/u.test(text)) throw new Error('Linux account group lookup returned invalid evidence');
  const values = text.split(/\s+/u).map((value) => unsigned(value, 'Linux account group id'));
  if (new Set(values).size !== values.length || !values.includes(account.gid)) {
    throw new Error('Linux account group lookup returned contradictory evidence');
  }
  return Object.freeze(values.sort((left, right) => left - right));
}

export async function observeLinuxLocalIdentities({
  accountNames = [],
  groupNames = [],
  platform = process.platform,
  invoke = invokeCommand,
  environment = process.env,
} = {}) {
  if (platform !== 'linux') return Object.freeze({ protocol: PROTOCOL, platform, applicable: false, accounts: Object.freeze([]), groups: Object.freeze([]) });
  if (typeof invoke !== 'function') throw new TypeError('Linux local identity invocation contract is invalid');
  const selectedAccounts = names(accountNames, 'Linux local account names');
  const selectedGroups = names(groupNames, 'Linux local group names');
  const accountLines = await Promise.all(selectedAccounts.map((name) => invokeLookup(invoke, environment, 'passwd', name)));
  const groupLines = await Promise.all(selectedGroups.map((name) => invokeLookup(invoke, environment, 'group', name)));
  const accounts = accountLines.map((line, index) => accountRecord(line, selectedAccounts[index]));
  const groups = groupLines.map((line, index) => groupRecord(line, selectedGroups[index]));
  const presentGids = groups.filter(Boolean).map((group) => group.gid);
  if (new Set(presentGids).size !== presentGids.length) throw new Error('Linux local group identities alias one numeric group');
  const groupIds = await Promise.all(accounts.map((account) => groupIdsFor(invoke, environment, account)));
  return Object.freeze({
    protocol: PROTOCOL,
    platform: 'linux',
    applicable: true,
    accounts: Object.freeze(selectedAccounts.map((name, index) => Object.freeze({ name, record: accounts[index], groupIds: groupIds[index] }))),
    groups: Object.freeze(selectedGroups.map((name, index) => Object.freeze({ name, record: groups[index] }))),
  });
}

export { PROTOCOL as LINUX_LOCAL_IDENTITIES_PROTOCOL };
