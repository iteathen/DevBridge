#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  assertSupportedNode,
  isExactHead,
  normalizeInstallRef,
  parseInstallArgs,
} from './permanent-entry-installer/input-contract.mjs';
import { createSourceChannel } from './permanent-entry-installer/source-channel.mjs';
import { createComponentStore } from './permanent-entry-installer/component-store.mjs';
import { createMutationLease } from './permanent-entry-installer/mutation-lease.mjs';
import { createEntryPublication } from './permanent-entry-installer/entry-publication.mjs';
import { createContinuation } from './permanent-entry-installer/continuation.mjs';
import { createOwnershipState } from './permanent-entry-installer/ownership-state.mjs';
import { createPublicationTreeOwnership } from './permanent-entry-installer/publication-tree-ownership.mjs';
import { createPublicationFileOwnership } from './permanent-entry-installer/publication-file-ownership.mjs';
import { createExactArtifactReceiptJournal } from '../runtime/exact-artifact-receipt.js';
import { createExactArtifactSet } from '../runtime/exact-artifact-set.js';
import { createReceiptItemCollection } from '../runtime/receipt-item-collection.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { createWindowsFilesystemEntryObserver } from '../runtime/providers/windows-filesystem-entry-observer.js';
import { PERMANENT_ENTRY_COMPONENT_FILES } from './permanent-entry-components.mjs';

export const INSTALL_PROTOCOL = 'devbridge/entry-install-v1';
export const INSTALL_STATUS_PROTOCOL = 'devbridge/entry-install-status-v1';
export const INSTALL_LOCK_PROTOCOL = 'devbridge/entry-install-lock-v1';
export const INSTALL_OWNERSHIP_REQUEST_PROTOCOL = 'devbridge/entry-install-ownership-request-v1';
export const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
export const INSTALLED_COMPONENT_FILES = PERMANENT_ENTRY_COMPONENT_FILES;

const sourceChannel = createSourceChannel({ normalizeSelector: normalizeInstallRef, defaultEndpoint: SOURCE_REPOSITORY });
const componentStore = createComponentStore({
  protocol: INSTALL_PROTOCOL,
  files: INSTALLED_COMPONENT_FILES,
  defaultEndpoint: SOURCE_REPOSITORY,
  manifestName: '.devbridge-entry-install.json',
  endpointField: 'sourceRepository',
});
const mutationLease = createMutationLease({ protocol: INSTALL_LOCK_PROTOCOL, fileName: '.install.lock' });
const entryPublication = createEntryPublication({
  statusProtocol: INSTALL_STATUS_PROTOCOL,
  isExactSubject: isExactHead,
  names: Object.freeze({
    directory: 'bin',
    primary: 'devbridge-entry.mjs',
    previous: 'devbridge-entry.previous.mjs',
    command: 'devbridge-entry.cmd',
    shell: 'devbridge-entry',
  }),
  route: Object.freeze({
    targetPrefix: '../entry/components/',
    targetSuffix: '/devbridge-entry.mjs',
    operation: 'runInstalledEntry',
    statusAction: 'entry-install-status',
    homeFlag: '--home',
    selectionFlag: '--ref',
    selectionAliases: Object.freeze(['--ref', '--branch']),
    alternateSelectionFlag: '--entry-development-ref',
    errorPrefix: '[devbridge-entry] ',
  }),
});
const continuation = createContinuation();

function fail(message) { throw new Error(message); }

function ensureRealDirectory(candidate, name, { create = false, recursive = false } = {}) {
  if (create && !existsSync(candidate)) mkdirSync(candidate, { recursive, mode: 0o700 });
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory.`);
  return realpathSync.native(candidate);
}

function ensureChildDirectory(parent, name) {
  const candidate = path.join(parent, name);
  if (!existsSync(candidate)) mkdirSync(candidate, { mode: 0o700 });
  return ensureRealDirectory(candidate, `${name} directory`);
}

function componentItemIdentity(head) { return `component.${head}`; }

export { assertSupportedNode, normalizeInstallRef, parseInstallArgs };

export function resolveInstallSubject(selector, {
  sourceRepository = SOURCE_REPOSITORY,
  runner = undefined,
  allowLocalSource = false,
  environment = process.env,
} = {}) {
  return sourceChannel.resolve(selector, { endpoint: sourceRepository, runner, allowLocalSource, environment });
}

export function verifyInstalledComponent(root, expectedHead, sourceRepository = SOURCE_REPOSITORY) {
  return componentStore.verify(root, expectedHead, sourceRepository);
}

export async function installDevBridge(options, {
  sourceRepository = SOURCE_REPOSITORY,
  runner = undefined,
  allowLocalSource = false,
  environment = process.env,
  preparedSource = null,
  invoke = invokeCommand,
  receiptJournalFactory = createExactArtifactReceiptJournal,
  artifactSetFactory = createExactArtifactSet,
  attributeObserverFactory = createWindowsFilesystemEntryObserver,
} = {}) {
  assertSupportedNode();
  const requestedHome = path.resolve(String(options?.home ?? path.join(homedir(), '.devbridge')));
  const home = ensureRealDirectory(requestedHome, 'DevBridge installation home', { create: true, recursive: true });
  return mutationLease.run(home, async () => {
    const entryRoot = ensureChildDirectory(home, 'entry');
    const selector = normalizeInstallRef(options?.selector?.value ?? options?.selector ?? 'main');
    const requestedRunnerRef = options?.selectedRunnerRef == null ? null : normalizeInstallRef(options.selectedRunnerRef).value;
    const subject = sourceChannel.resolve(selector, { endpoint: sourceRepository, runner, allowLocalSource, environment });
    const preparedRoot = sourceChannel.acceptPrepared(subject, preparedSource);
    const selectedRunnerRef = requestedRunnerRef;
    const selectedRunnerSelector = selectedRunnerRef == null ? null : normalizeInstallRef(selectedRunnerRef);
    const pinnedRunnerHead = selectedRunnerSelector?.kind === 'exact' ? selectedRunnerSelector.value : null;

    const components = ensureChildDirectory(entryRoot, 'components');
    const stagingRoot = ensureChildDirectory(entryRoot, 'staging');
    const quarantineRoot = ensureChildDirectory(entryRoot, 'quarantine');
    const receiptScratch = ensureChildDirectory(entryRoot, 'ownership-scratch');
    const receiptDirectory = path.join(entryRoot, 'ownership-receipts');
    const journal = receiptJournalFactory({ directory: receiptDirectory, scratch: receiptScratch });
    const ownership = createOwnershipState({ collection: createReceiptItemCollection({ journal }) });
    await ownership.open();
    const attributeObserver = process.platform === 'win32' ? attributeObserverFactory({ invoke }) : null;
    const artifacts = artifactSetFactory({
      platform: process.platform,
      ...(attributeObserver ? { inspectReparse: (location) => attributeObserver.isReparse(location) } : {}),
    });
    const target = path.join(components, subject.head);
    const treeOwnership = createPublicationTreeOwnership({
      protocol: INSTALL_OWNERSHIP_REQUEST_PROTOCOL,
      state: ownership,
      artifacts,
      publication: componentStore,
    });
    await treeOwnership.install({
      identity: componentItemIdentity(subject.head),
      target,
      stagingRoot,
      preservationRoot: quarantineRoot,
      subject: subject.head,
      endpoint: sourceRepository,
      obtainSource: (destination) => preparedRoot ?? sourceChannel.materialize(subject, destination, {
        endpoint: sourceRepository, runner, allowLocalSource, environment,
      }),
    });

    const fileOwnership = createPublicationFileOwnership({
      protocol: INSTALL_OWNERSHIP_REQUEST_PROTOCOL,
      state: ownership,
      artifacts,
      publication: entryPublication,
      acceptReference: (reference) => componentStore.verify(
        path.join(components, reference.subject),
        reference.subject,
        sourceRepository,
      ),
    });
    const published = await fileOwnership.install({
      root: home,
      subject: subject.head,
      selection: selectedRunnerRef,
      identities: Object.freeze({
        primary: 'entry.primary',
        previous: 'entry.previous',
        command: 'entry.command',
        shell: 'entry.shell',
      }),
    });
    const wrappers = Object.freeze({ javascript: published.primary, command: published.command, shell: published.shell });
    return Object.freeze({
      protocol: INSTALL_PROTOCOL,
      home,
      componentHead: subject.head,
      selectedRunnerRef,
      pinnedRunnerHead,
      wrappers,
    });
  });
}

export async function trackInstalledRunnerRef({ home = null, ref } = {}, dependencies = {}) {
  const selector = normalizeInstallRef(ref);
  if (selector.kind !== 'branch') fail('Tracked runner ref must be a branch selector.');
  return await installDevBridge({ home, selector, selectedRunnerRef: selector.value }, dependencies);
}

export function observeInstallActivity({ home = null } = {}) {
  const requestedHome = path.resolve(String(home ?? path.join(homedir(), '.devbridge')));
  if (!existsSync(requestedHome)) return Object.freeze({ active: false });
  const selectedHome = ensureRealDirectory(requestedHome, 'DevBridge installation home');
  return mutationLease.observe(selectedHome);
}

export function runInstallActivity({ home = null } = {}, operation) {
  if (typeof operation !== 'function') throw new TypeError('installation activity operation must be a function');
  const requestedHome = path.resolve(String(home ?? path.join(homedir(), '.devbridge')));
  const selectedHome = ensureRealDirectory(requestedHome, 'DevBridge installation home');
  return mutationLease.run(selectedHome, operation);
}

export function runInstalledSetup(installed, dependencies = {}) {
  const launcher = installed?.wrappers?.javascript;
  if (typeof installed?.home !== 'string' || !path.isAbsolute(installed.home) ||
      typeof launcher !== 'string' || !path.isAbsolute(launcher)) {
    throw new TypeError('installed setup handoff requires one exact installed DevBridge launcher');
  }
  const selected = installed?.selectedRunnerRef ?? null;
  const initialHead = String(installed?.componentHead ?? '').toLowerCase();
  if (selected != null && !isExactHead(initialHead)) fail('selected runner setup handoff requires one exact installed component head');
  const selectorArgs = selected == null ? [] : ['--ref', initialHead];
  return continuation.run({
    launcher,
    arguments: [...selectorArgs, 'setup'],
    workingDirectory: installed.home,
  }, dependencies);
}

export function installHelp() {
  return `DevBridge permanent-entry installer

Usage:
  node install-devbridge.mjs [--home <path>]
  node install-devbridge.mjs --ref <branch-or-exact-head> [--home <path>]
  node install-devbridge.mjs --install-only [--ref <branch-or-exact-head>] [--home <path>]

By default the installer establishes the permanent entry and immediately enters the installed runner's public DevBridge setup path.
No selector installs the permanent entry from the exact current main head and leaves normal stable runner selection active.
An explicit branch selector is persisted as local development-channel authority and is re-resolved to an exact verified runner on later invocations; an explicit exact head remains exact-pinned.
The installer's first setup handoff remains bound to the exact subject resolved for that installation attempt.
--install-only stops after permanent-entry installation for explicit qualification/recovery work.
The installer writes devbridge-entry.* beside any existing devbridge.mjs Stage-0 launcher; it does not overwrite Stage 0.
`;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const args = parseInstallArgs(process.argv.slice(2));
    if (args.help) process.stdout.write(installHelp());
    else {
      const installed = await installDevBridge(args);
      if (args.runSetup) process.exitCode = runInstalledSetup(installed);
      else process.stdout.write(`${JSON.stringify(installed)}\n`);
    }
  } catch (error) {
    process.stderr.write(`[devbridge-installer] ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
