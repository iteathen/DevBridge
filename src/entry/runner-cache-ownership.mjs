import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createExactArtifactReceiptJournal } from '../runtime/exact-artifact-receipt.js';
import { createExactValueState } from '../runtime/exact-value-state.js';
import { createProcessActivityLease } from '../runtime/process-activity-lease.js';
import { createReceiptItemCollection } from '../runtime/receipt-item-collection.js';

export const RUNNER_CACHE_OWNERSHIP_VALUE_PROTOCOL = 'devbridge/runner-cache-ownership-value-v1';

const ACTIVITY_PROTOCOL = 'devbridge/runner-cache-activity-v1';
const ACTIVITY_FILE = '.runner-cache.activity';
const CONTROL_IDENTITY = 'control';

function fail(message) { throw new Error(message); }

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`${name} contract is incomplete`);
  }
  return value;
}

async function presence(location) {
  try { await lstat(location); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export function runnerCacheOwnershipPaths(stateRoot) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    throw new TypeError('runner-cache state root must be an absolute local path');
  }
  const root = path.resolve(stateRoot);
  return Object.freeze({
    root,
    receipts: path.join(root, 'cache-ownership-receipts'),
    scratch: path.join(root, 'cache-ownership-scratch'),
  });
}

export function createRunnerCacheOwnership({ stateRoot, directories } = {}, {
  journalFactory = createExactArtifactReceiptJournal,
  stateFactory = createExactValueState,
  leaseFactory = createProcessActivityLease,
} = {}) {
  const paths = runnerCacheOwnershipPaths(stateRoot);
  const directoryAction = requirePort(directories, ['plan', 'observe'], 'runner-cache directory action');
  const collection = journalFactory({ directory: paths.receipts, scratch: paths.scratch });
  const state = stateFactory({
    collection: createReceiptItemCollection({ journal: collection }),
    protocol: RUNNER_CACHE_OWNERSHIP_VALUE_PROTOCOL,
    controlIdentity: CONTROL_IDENTITY,
  });
  const lease = leaseFactory({ protocol: ACTIVITY_PROTOCOL, fileName: ACTIVITY_FILE });

  async function ensureDirectory(records, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || typeof raw.identity !== 'string' || typeof raw.location !== 'string' || !path.isAbsolute(raw.location)) {
      throw new TypeError('runner-cache directory request is invalid');
    }
    const request = Object.freeze({ kind: 'directory', location: path.resolve(raw.location) });
    let current = await records.read(raw.identity);
    if (current?.value.phase === 'complete') {
      if (!isDeepStrictEqual(current.value.request, request)) fail('runner-cache directory receipt conflicts with its local request');
      const observed = await directoryAction.observe(structuredClone(current.value.value));
      if (observed.state !== 'present') fail('runner-cache directory receipt does not match local state');
      return current;
    }
    if (current?.value.phase === 'reserved' && !isDeepStrictEqual(current.value.request, request)) {
      fail('runner-cache directory has another pending local request');
    }
    if (!current) {
      current = await records.reserve({
        identity: raw.identity,
        provenance: await presence(request.location) ? 'adopted' : 'created',
        request,
      });
    }
    if (!(await presence(request.location))) {
      if (current.provenance !== 'created') fail('runner-cache adopted directory disappeared before completion');
      await mkdir(request.location, { mode: 0o700 });
    }
    const value = await directoryAction.plan({ identity: raw.identity, location: request.location });
    return records.complete({ reservation: current, value });
  }

  async function withActivity(work) {
    if (typeof work !== 'function') throw new TypeError('runner-cache activity work must be a function');
    await mkdir(paths.scratch, { recursive: true, mode: 0o700 });
    return lease.run(paths.root, async () => {
      await state.open();
      const session = Object.freeze({
        read: state.read,
        reserve: state.reserve,
        complete: state.complete,
        record: state.record,
        replace: state.replace,
        clear: state.clear,
        directory(raw) { return ensureDirectory(state, raw); },
      });
      return await work(session);
    });
  }

  async function duringActivity(work) {
    if (typeof work !== 'function') throw new TypeError('runner-cache activity work must be a function');
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    return lease.run(paths.root, work);
  }

  return Object.freeze({
    withActivity,
    duringActivity,
    observe() { return lease.observe(paths.root); },
  });
}
