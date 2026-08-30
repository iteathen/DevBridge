import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 4096;
const OBJECT = /^cache\.object\.([0-9a-f]{64})$/u;
const CHECKOUT = /^cache\.checkout\.([0-9a-f]{64})$/u;
const FIXED = new Set([
  'cache.directory.root',
  'cache.directory.objects',
  'cache.directory.checkouts',
  'cache.directory.control',
  'cache.file.control',
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function generation(value) {
  return `generation-${createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex')}`;
}

function knownIdentity(value) {
  return FIXED.has(value) || OBJECT.test(value) || CHECKOUT.test(value);
}

function request(raw, expectedIdentity) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1
      || raw.identity !== expectedIdentity) throw new TypeError('runner-cache inventory observation identity changed');
}

async function entryList(location, { inspect, list, isReparse }, count) {
  let root;
  try { root = await inspect(location); }
  catch (error) { if (error?.code === 'ENOENT') return Object.freeze({ state: 'absent', entries: Object.freeze([]) }); throw error; }
  if (!root.isDirectory() || root.isSymbolicLink() || await isReparse(location, root)) {
    return Object.freeze({ state: 'unsafe', entries: Object.freeze([]) });
  }
  const raw = await list(location, { withFileTypes: true });
  count.value += raw.length;
  if (count.value > MAX_ENTRIES) throw new Error('runner-cache topology exceeds its entry bound');
  const entries = [];
  for (const member of raw.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(location, member.name);
    const info = await inspect(child);
    const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    const unsafe = info.isSymbolicLink() || await isReparse(child, info);
    entries.push(Object.freeze({ name: member.name, kind, unsafe }));
  }
  return Object.freeze({ state: 'present', entries: Object.freeze(entries) });
}

function expectedRoot(items) {
  const names = [];
  if (items.has('cache.directory.objects')) names.push('objects');
  if (items.has('cache.directory.checkouts')) names.push('checkouts');
  if (items.has('cache.directory.control')) names.push('control-home');
  return names.sort();
}

function expectedObjects(items) {
  return [...items].flatMap((identity) => {
    const match = identity.match(OBJECT);
    return match ? [`${match[1]}.mjs`] : [];
  }).sort();
}

function expectedCheckouts(items) {
  return [...items].flatMap((identity) => identity.match(CHECKOUT)?.slice(1) ?? []).sort();
}

function namesMatch(observed, expected, kind) {
  if (observed.state === 'absent') return true;
  if (observed.state !== 'present') return false;
  if (observed.entries.some((entry) => entry.unsafe || entry.kind !== kind)) return false;
  const actual = observed.entries.map((entry) => entry.name).sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function topologyComplete(topology, items) {
  if (topology.root.state === 'absent') return items.size === 0;
  if (!items.has('cache.directory.root') || !namesMatch(topology.root, expectedRoot(items), 'directory')) return false;
  if (!namesMatch(topology.objects, expectedObjects(items), 'file')) return false;
  if (!namesMatch(topology.checkouts, expectedCheckouts(items), 'directory')) return false;
  const controlExpected = items.has('cache.file.control') ? ['gitconfig'] : [];
  return namesMatch(topology.control, controlExpected, 'file');
}

export function createRunnerCacheInventorySource({
  identity,
  source,
  cacheRoot,
  inspect = lstat,
  list = readdir,
  inspectReparse = async (_location, info) => info.isSymbolicLink(),
} = {}) {
  if (typeof identity !== 'string' || !identity || !source || typeof source.observe !== 'function'
      || typeof cacheRoot !== 'string' || !path.isAbsolute(cacheRoot)
      || typeof inspect !== 'function' || typeof list !== 'function' || typeof inspectReparse !== 'function') {
    throw new TypeError('runner-cache inventory source contract is incomplete');
  }
  const root = path.resolve(cacheRoot);
  const ports = Object.freeze({ inspect, list, isReparse: inspectReparse });

  return Object.freeze({
    async observe(rawRequest) {
      request(rawRequest, identity);
      const receipts = await source.observe(Object.freeze({ identity }));
      if (!receipts || receipts.identity !== identity || !Array.isArray(receipts.items)) {
        throw new TypeError('runner-cache receipt projection is invalid');
      }
      if (receipts.items.some((item) => !knownIdentity(item.identity))) {
        throw new Error('runner-cache receipt contains an unsupported local identity');
      }
      const items = new Set(receipts.items.map((item) => item.identity));
      const count = { value: 0 };
      const rootState = await entryList(root, ports, count);
      const child = async (name) => rootState.state === 'present'
        ? entryList(path.join(root, name), ports, count)
        : Object.freeze({ state: 'absent', entries: Object.freeze([]) });
      const topology = Object.freeze({
        root: rootState,
        objects: await child('objects'),
        checkouts: await child('checkouts'),
        control: await child('control-home'),
      });
      const absentWithoutReceipts = receipts.generation === 'generation-absent' && rootState.state === 'absent';
      return Object.freeze({
        identity,
        generation: generation({ receipt: receipts.generation, topology }),
        complete: absentWithoutReceipts || (receipts.complete === true && topologyComplete(topology, items)),
        items: Object.freeze([...receipts.items]),
      });
    },
  });
}

export function runnerCacheIdentitySelected(identity) {
  if (!knownIdentity(identity)) throw new Error('runner-cache receipt contains an unsupported local identity');
  return true;
}

export function runnerCacheRelationships({ identity, available }) {
  const present = new Set(available);
  let after = [];
  if (identity === 'cache.directory.objects') after = available.filter((value) => OBJECT.test(value));
  else if (identity === 'cache.directory.checkouts') after = available.filter((value) => CHECKOUT.test(value));
  else if (identity === 'cache.directory.control') after = present.has('cache.file.control') ? ['cache.file.control'] : [];
  else if (identity === 'cache.directory.root') {
    after = ['cache.directory.objects', 'cache.directory.checkouts', 'cache.directory.control'].filter((value) => present.has(value));
  }
  return Object.freeze({ protections: Object.freeze([]), references: Object.freeze([]), after: Object.freeze(after.sort()) });
}
