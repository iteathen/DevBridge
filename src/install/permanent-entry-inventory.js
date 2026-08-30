import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { observeInstallActivity } from './permanent-entry-installer.mjs';
import { createOwnershipInventorySource } from './permanent-entry-installer/ownership-inventory-source.mjs';
import { OWNERSHIP_VALUE_PROTOCOL } from './permanent-entry-installer/ownership-state.mjs';
import { EXACT_ARTIFACT_RECEIPT_PROTOCOL, createExactArtifactReceiptJournal } from '../runtime/exact-artifact-receipt.js';
import { createExactArtifactSet } from '../runtime/exact-artifact-set.js';
import { createExactValueInventory } from '../runtime/exact-value-inventory.js';
import { createWindowsFilesystemEntryObserver } from '../runtime/providers/windows-filesystem-entry-observer.js';
import { createRevisionedRecordStateStore } from '../state/revisioned-record-state-store.js';
import { invokeCommand } from '../runtime/command-invocation.js';

export const ENTRY_PAYLOAD_INVENTORY_IDENTITY = 'entry-payload';

const COMPONENT = /^component\.[0-9a-f]{40}$/u;
const ENTRIES = Object.freeze(['entry.command', 'entry.previous', 'entry.primary', 'entry.shell']);
const ENTRY_SET = new Set(ENTRIES);

function included(identity) {
  return COMPONENT.test(identity) || ENTRY_SET.has(identity);
}

function relationships({ identity, available }) {
  const selected = new Set(available);
  return Object.freeze({
    protections: Object.freeze([]),
    references: Object.freeze([]),
    after: Object.freeze(COMPONENT.test(identity) ? ENTRIES.filter((entry) => selected.has(entry)) : []),
  });
}

export function createPermanentEntryInventory({ home = null } = {}, {
  receiptJournalFactory = createExactArtifactReceiptJournal,
  recordStoreFactory = createRevisionedRecordStateStore,
  artifactSetFactory = (options) => createExactArtifactSet(options),
  activityObserver = observeInstallActivity,
  attributeObserverFactory = createWindowsFilesystemEntryObserver,
  invoke = invokeCommand,
} = {}) {
  const selectedHome = path.resolve(String(home ?? path.join(homedir(), '.devbridge')));
  const entryRoot = path.join(selectedHome, 'entry');
  const journal = receiptJournalFactory({
    directory: path.join(entryRoot, 'ownership-receipts'),
    scratch: path.join(entryRoot, 'ownership-scratch'),
  });
  const source = createOwnershipInventorySource({
    identity: ENTRY_PAYLOAD_INVENTORY_IDENTITY,
    collection: journal,
    collectionProtocol: EXACT_ARTIFACT_RECEIPT_PROTOCOL,
    valueProtocol: OWNERSHIP_VALUE_PROTOCOL,
    controlIdentity: 'control',
    include: included,
    relate: relationships,
  });
  const activity = Object.freeze({
    async observe({ identity }) {
      if (identity !== ENTRY_PAYLOAD_INVENTORY_IDENTITY) throw new TypeError('entry payload activity identity changed');
      const observed = await activityObserver({ home: selectedHome });
      if (!observed || typeof observed.active !== 'boolean') throw new TypeError('entry payload activity observation is invalid');
      return Object.freeze({ identity, active: observed.active });
    },
  });
  const attributeObserver = process.platform === 'win32' ? attributeObserverFactory({ invoke }) : null;
  const actions = artifactSetFactory({
    platform: process.platform,
    ...(attributeObserver ? { inspectReparse: (location) => attributeObserver.isReparse(location) } : {}),
  });
  const records = recordStoreFactory(path.join(entryRoot, 'ownership-bindings.json'));
  return createExactValueInventory({
    identity: ENTRY_PAYLOAD_INVENTORY_IDENTITY,
    scope: 'payload',
    coverage: ['application'],
    source,
    activity,
    records,
    actions,
  });
}
