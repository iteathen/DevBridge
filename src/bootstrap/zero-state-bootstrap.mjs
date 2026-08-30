#!/usr/bin/env node
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  assertSupportedNode,
  isExactHead,
  normalizeBootstrapRef,
  parseBootstrapArgs,
} from './zero-state-bootstrap/input-contract.mjs';
import { createSelectionState } from './zero-state-bootstrap/selection-state.mjs';
import { createSourceChannel } from './zero-state-bootstrap/source-channel.mjs';
import { createTemporaryMaterialization } from './zero-state-bootstrap/temporary-materialization.mjs';

export const BOOTSTRAP_PROTOCOL = 'devbridge/zero-state-bootstrap-v1';
export const SOURCE_ID = 'iteathen/DevBridge';
export const STAGE_PATH = 'install-devbridge.mjs';
export const SOURCE_STAGE_PATH = 'src/bootstrap/exact-source-acquisition.mjs';

const USER_AGENT = 'DevBridge-zero-state-bootstrap/1';
const SOURCE_RAW_BASE = 'https://raw.githubusercontent.com/iteathen/DevBridge/';
const SOURCE_API_BASE = 'https://api.github.com/repos/iteathen/DevBridge/git/ref/heads/';

const selectionState = createSelectionState({
  protocol: BOOTSTRAP_PROTOCOL,
  source: SOURCE_ID,
  normalizeSelector: normalizeBootstrapRef,
  isExactHead,
  directoryName: 'bootstrap',
  recordName: 'selection.json',
});
const sourceChannel = createSourceChannel({
  apiBase: SOURCE_API_BASE,
  rawBase: SOURCE_RAW_BASE,
  userAgent: USER_AGENT,
  stagePath: STAGE_PATH,
  helperPath: SOURCE_STAGE_PATH,
  normalizeSelector: normalizeBootstrapRef,
  isExactHead,
});
const temporaryMaterialization = createTemporaryMaterialization();

function fail(message) { throw new Error(message); }

export { assertSupportedNode, normalizeBootstrapRef, parseBootstrapArgs };

export function bootstrapSelectionPath(home) {
  return selectionState.pathFor(home);
}

export function readBootstrapSelection(home) {
  return selectionState.read(home);
}

export async function resolveBootstrapSubject(selector, dependencies = {}) {
  return sourceChannel.resolve(selector, dependencies);
}

export async function resolveDurableBootstrapSubject(options, { fetcher = globalThis.fetch } = {}) {
  return selectionState.resolve(options, {
    resolveSubject: (selector) => sourceChannel.resolve(selector, { fetcher }),
  });
}

export function clearBootstrapSelection(subject) {
  return selectionState.clear(subject);
}

export async function fetchBootstrapStage(head, dependencies = {}) {
  return sourceChannel.fetchStage(head, dependencies);
}

async function defaultLoadStage(stagePath) {
  return temporaryMaterialization.load(stagePath);
}

async function defaultPrepareSource(stage, subject, { fetcher, bootstrapRoot }) {
  if (!Array.isArray(stage?.INSTALLED_COMPONENT_FILES) || stage.INSTALLED_COMPONENT_FILES.length < 1) {
    fail('Bootstrap stage source contract is unavailable.');
  }
  const helperBytes = await sourceChannel.fetchHelper(subject.head, { fetcher });
  const helperPath = temporaryMaterialization.write(bootstrapRoot, subject.head, helperBytes, 'source-stage');
  const destination = temporaryMaterialization.directory(bootstrapRoot, subject.head);
  try {
    const helper = await temporaryMaterialization.load(helperPath);
    if (typeof helper?.materializeExactSource !== 'function') fail('Bootstrap source-acquisition contract is unavailable.');
    const prepared = await helper.materializeExactSource({
      revision: subject.head,
      paths: stage.INSTALLED_COMPONENT_FILES,
      destination,
      sourceBase: SOURCE_RAW_BASE,
      fetcher,
      userAgent: USER_AGENT,
    });
    return Object.freeze({
      head: subject.head,
      root: prepared.root,
      cleanup() {
        temporaryMaterialization.removeTree(prepared.root);
        temporaryMaterialization.removeFile(helperPath);
      },
    });
  } catch (error) {
    temporaryMaterialization.removeTree(destination);
    temporaryMaterialization.removeFile(helperPath);
    throw error;
  }
}

export async function runZeroStateBootstrap(argv, {
  environment = process.env,
  homeDirectory = homedir(),
  fetcher = globalThis.fetch,
  loadStage = defaultLoadStage,
  prepareSource = defaultPrepareSource,
} = {}) {
  assertSupportedNode();
  const options = parseBootstrapArgs(argv, { environment, homeDirectory });
  if (options.help) return Object.freeze({ help: true, status: 0 });

  const subject = await resolveDurableBootstrapSubject(options, { fetcher });
  const bytes = await fetchBootstrapStage(subject.head, { fetcher });
  const bootstrapRoot = path.dirname(bootstrapSelectionPath(subject.home));
  const stagePath = temporaryMaterialization.write(bootstrapRoot, subject.head, bytes);
  try {
    const stage = await loadStage(stagePath);
    if (typeof stage?.installDevBridge !== 'function' || typeof stage?.runInstalledSetup !== 'function') {
      fail('Bootstrap stage contract is unavailable.');
    }
    const prepared = await prepareSource(stage, subject, { fetcher, bootstrapRoot });
    try {
      const installed = await stage.installDevBridge({
        home: subject.home,
        selector: Object.freeze({ kind: 'exact', value: subject.head }),
        selectedRunnerRef: options.explicitSelector ? options.selector.value : null,
      }, {
        environment,
        preparedSource: Object.freeze({ head: subject.head, root: prepared.root }),
      });
      clearBootstrapSelection(subject);

      if (!options.runSetup) return Object.freeze({ help: false, status: 0, installed, subject });
      const status = stage.runInstalledSetup(installed, { environment });
      if (!Number.isInteger(status)) fail('Bootstrap continuation exited without a bounded status code.');
      return Object.freeze({ help: false, status, installed, subject });
    } finally {
      try { prepared.cleanup?.(); } catch {}
    }
  } finally {
    temporaryMaterialization.removeFile(stagePath);
  }
}

export function bootstrapHelp() {
  return `DevBridge zero-state bootstrap\n\nUsage:\n  <Node first-byte loader> [--home <path>]\n  <Node first-byte loader> --ref <branch-or-exact-head> [--home <path>]\n  <Node first-byte loader> --install-only [--ref <branch-or-exact-head>] [--home <path>]\n\nThe first-byte loader requires only supported Node.js. A moving ref is durably bound to one exact subject before the next stage runs; an interrupted argument-equivalent retry resumes that exact subject.\n`;
}

const invokedFromData = import.meta.url.startsWith('data:text/javascript');
const invokedFromFile = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedFromData || invokedFromFile) {
  const argv = invokedFromData ? process.argv.slice(1) : process.argv.slice(2);
  runZeroStateBootstrap(argv).then((result) => {
    if (result.help) process.stdout.write(bootstrapHelp());
    else if (result.installed && !parseBootstrapArgs(argv).runSetup) process.stdout.write(`${JSON.stringify(result.installed)}\n`);
    process.exitCode = result.status;
  }).catch((error) => {
    process.stderr.write(`[devbridge-bootstrap] ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
