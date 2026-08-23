#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const BOOTSTRAP_PROTOCOL = 'devbridge/zero-state-bootstrap-v1';
export const SOURCE_ID = 'iteathen/DevBridge';
export const STAGE_PATH = 'install-devbridge.mjs';
export const SOURCE_STAGE_PATH = 'src/bootstrap/exact-source-acquisition.mjs';

const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u;
const MAX_RECORD_BYTES = 4096;
const MAX_STAGE_BYTES = 512 * 1024;
const MAX_SOURCE_STAGE_BYTES = 128 * 1024;
const USER_AGENT = 'DevBridge-zero-state-bootstrap/1';
const SOURCE_RAW_BASE = 'https://raw.githubusercontent.com/iteathen/DevBridge/';

function fail(message) { throw new Error(message); }

export function assertSupportedNode(version = process.versions.node) {
  const parts = String(version).split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length < 3 || parts.some((value) => !Number.isInteger(value))) {
    fail(`Could not parse Node.js version: ${version}`);
  }
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return;
    if (parts[index] < MINIMUM_NODE[index]) fail('DevBridge requires Node.js 22.16.0 or newer.');
  }
}

function expandHome(value, homeDirectory = homedir()) {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDirectory, value.slice(2));
  return value;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || !value || value.startsWith('-')) fail(`${flag} requires a value`);
  return value;
}

export function normalizeBootstrapRef(value) {
  const ref = String(value ?? '');
  const exact = ref.toLowerCase();
  if (EXACT_HEAD.test(exact)) return Object.freeze({ kind: 'exact', value: exact });
  const segments = ref.split('/');
  if (!SAFE_REF.test(ref) || ref.startsWith('-') || ref.includes('\\') || ref.endsWith('/') || ref.endsWith('.lock') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('Bootstrap ref is invalid.');
  }
  return Object.freeze({ kind: 'branch', value: ref });
}

export function parseBootstrapArgs(argv, { environment = process.env, homeDirectory = homedir() } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('bootstrap argv must be an array');
  let home = environment.DEVBRIDGE_HOME ?? path.join(homeDirectory, '.devbridge');
  let selector = null;
  let help = false;
  let runSetup = true;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') { help = true; continue; }
    if (value === '--install-only') { runSetup = false; continue; }
    if (value === '--home') {
      home = takeValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === '--ref' || value === '--branch') {
      if (selector != null) fail('Only one bootstrap ref/branch selector may be supplied.');
      selector = normalizeBootstrapRef(takeValue(argv, index, value));
      index += 1;
      continue;
    }
    fail(`Unsupported bootstrap argument: ${value}`);
  }
  return Object.freeze({
    help,
    home: path.resolve(expandHome(String(home), homeDirectory)),
    selector: selector ?? Object.freeze({ kind: 'branch', value: 'main' }),
    explicitSelector: selector != null,
    runSetup,
  });
}

function ensureRealDirectory(candidate, name, { create = false, recursive = false } = {}) {
  if (create && !existsSync(candidate)) mkdirSync(candidate, { recursive, mode: 0o700 });
  const info = lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory.`);
  return realpathSync.native(candidate);
}

function ensureChildDirectory(parent, name) {
  const candidate = path.join(parent, name);
  if (!existsSync(candidate)) mkdirSync(candidate, { mode: 0o700 });
  return ensureRealDirectory(candidate, `Bootstrap ${name} directory`);
}

function sameSelector(left, right) {
  return left?.kind === right?.kind && left?.value === right?.value;
}

function validateSelectionRecord(record) {
  if (record?.protocol !== BOOTSTRAP_PROTOCOL || record?.source !== SOURCE_ID ||
      !EXACT_HEAD.test(String(record?.head ?? '').toLowerCase())) {
    fail('Bootstrap selection record is invalid.');
  }
  const selector = normalizeBootstrapRef(record?.selector?.value);
  if (selector.kind !== record?.selector?.kind || selector.value !== record?.selector?.value) {
    fail('Bootstrap selection record is invalid.');
  }
  return Object.freeze({
    protocol: BOOTSTRAP_PROTOCOL,
    source: SOURCE_ID,
    selector,
    head: String(record.head).toLowerCase(),
  });
}

export function bootstrapSelectionPath(home) {
  return path.join(path.resolve(home), 'bootstrap', 'selection.json');
}

export function readBootstrapSelection(home) {
  const selectionPath = bootstrapSelectionPath(home);
  if (!existsSync(selectionPath)) return null;
  const info = lstatSync(selectionPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_RECORD_BYTES) {
    fail('Bootstrap selection record is invalid.');
  }
  try {
    return validateSelectionRecord(JSON.parse(readFileSync(selectionPath, 'utf8')));
  } catch (error) {
    if (error?.message === 'Bootstrap selection record is invalid.') throw error;
    fail('Bootstrap selection record is invalid.');
  }
}

async function readBoundedResponse(response, name, maxBytes) {
  if (!response || response.ok !== true || response.status !== 200) {
    fail(`${name} request failed with status ${response?.status ?? 'unknown'}.`);
  }
  const declared = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isInteger(declared) && declared > maxBytes) fail(`${name} response is too large.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > maxBytes) fail(`${name} response size is invalid.`);
  return bytes;
}

async function requestBytes(url, { fetcher = globalThis.fetch, name, maxBytes, accept }) {
  if (typeof fetcher !== 'function') fail('Node fetch support is unavailable.');
  const response = await fetcher(url, {
    method: 'GET',
    redirect: 'error',
    headers: Object.freeze({
      Accept: accept,
      'User-Agent': USER_AGENT,
    }),
  });
  return readBoundedResponse(response, name, maxBytes);
}

function exactRawUrl(head, relative) {
  const encoded = String(relative).split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${SOURCE_RAW_BASE}${head}/${encoded}`;
}

export async function resolveBootstrapSubject(selector, { fetcher = globalThis.fetch } = {}) {
  const normalized = normalizeBootstrapRef(selector?.value ?? selector);
  if (normalized.kind === 'exact') return normalized.value;
  const encodedRef = normalized.value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const bytes = await requestBytes(`https://api.github.com/repos/iteathen/DevBridge/git/ref/heads/${encodedRef}`, {
    fetcher,
    name: 'Bootstrap subject',
    maxBytes: 64 * 1024,
    accept: 'application/vnd.github+json',
  });
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); }
  catch { fail('Bootstrap subject response is invalid.'); }
  const expectedRef = `refs/heads/${normalized.value}`;
  const head = String(payload?.object?.sha ?? '').toLowerCase();
  if (payload?.ref !== expectedRef || !EXACT_HEAD.test(head)) fail('Bootstrap subject response is invalid.');
  return head;
}

function ensureBootstrapHome(requestedHome) {
  if (!existsSync(requestedHome)) mkdirSync(requestedHome, { recursive: true, mode: 0o700 });
  const home = ensureRealDirectory(requestedHome, 'DevBridge bootstrap home');
  const bootstrap = ensureChildDirectory(home, 'bootstrap');
  return Object.freeze({ home, bootstrap });
}

function writeSelectionCandidate(bootstrap, record) {
  const temporary = path.join(bootstrap, `.selection-${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true,
  });
  return temporary;
}

export async function resolveDurableBootstrapSubject(options, { fetcher = globalThis.fetch } = {}) {
  const roots = ensureBootstrapHome(path.resolve(options.home));
  const existing = readBootstrapSelection(roots.home);
  if (existing) {
    if (!sameSelector(existing.selector, options.selector)) {
      fail(`Bootstrap recovery is already bound to ${existing.selector.value} at ${existing.head}; resume that selection before starting another subject.`);
    }
    return Object.freeze({ ...existing, home: roots.home, resumed: true });
  }

  const head = await resolveBootstrapSubject(options.selector, { fetcher });
  const record = Object.freeze({
    protocol: BOOTSTRAP_PROTOCOL,
    source: SOURCE_ID,
    selector: options.selector,
    head,
  });
  const temporary = writeSelectionCandidate(roots.bootstrap, record);
  const selectionPath = path.join(roots.bootstrap, 'selection.json');
  try {
    try {
      linkSync(temporary, selectionPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const winner = readBootstrapSelection(roots.home);
      if (!winner || !sameSelector(winner.selector, options.selector)) {
        fail('A different bootstrap selection became authoritative concurrently.');
      }
      return Object.freeze({ ...winner, home: roots.home, resumed: true });
    }
    return Object.freeze({ ...record, home: roots.home, resumed: false });
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

export function clearBootstrapSelection(subject) {
  const current = readBootstrapSelection(subject.home);
  if (!current) return;
  if (current.head !== subject.head || !sameSelector(current.selector, subject.selector)) {
    fail('Bootstrap selection changed before installation commit reconciliation.');
  }
  unlinkSync(bootstrapSelectionPath(subject.home));
}

export async function fetchBootstrapStage(head, { fetcher = globalThis.fetch } = {}) {
  const exact = String(head ?? '').toLowerCase();
  if (!EXACT_HEAD.test(exact)) fail('Bootstrap stage requires an exact subject.');
  return requestBytes(exactRawUrl(exact, STAGE_PATH), {
    fetcher,
    name: 'Bootstrap stage',
    maxBytes: MAX_STAGE_BYTES,
    accept: 'application/octet-stream',
  });
}

async function defaultLoadStage(stagePath) {
  return import(pathToFileURL(stagePath).href);
}

function writeStage(bootstrapRoot, head, bytes, role = 'stage') {
  const stagePath = path.join(bootstrapRoot, `.${role}-${head.slice(0, 12)}-${process.pid}-${randomUUID()}.mjs`);
  writeFileSync(stagePath, bytes, { mode: 0o600, flag: 'wx', flush: true });
  return stagePath;
}

async function defaultPrepareSource(stage, subject, { fetcher, bootstrapRoot }) {
  if (!Array.isArray(stage?.INSTALLED_COMPONENT_FILES) || stage.INSTALLED_COMPONENT_FILES.length < 1) {
    fail('Bootstrap stage source contract is unavailable.');
  }
  const helperBytes = await requestBytes(exactRawUrl(subject.head, SOURCE_STAGE_PATH), {
    fetcher,
    name: 'Bootstrap source-acquisition stage',
    maxBytes: MAX_SOURCE_STAGE_BYTES,
    accept: 'application/octet-stream',
  });
  const helperPath = writeStage(bootstrapRoot, subject.head, helperBytes, 'source-stage');
  const destination = path.join(
    bootstrapRoot,
    `.source-${subject.head.slice(0, 12)}-${process.pid}-${randomUUID()}`,
  );
  try {
    const helper = await import(pathToFileURL(helperPath).href);
    if (typeof helper?.materializeExactSource !== 'function') {
      fail('Bootstrap source-acquisition contract is unavailable.');
    }
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
        try { rmSync(prepared.root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); } catch {}
        try { rmSync(helperPath, { force: true }); } catch {}
      },
    });
  } catch (error) {
    try { rmSync(destination, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); } catch {}
    try { rmSync(helperPath, { force: true }); } catch {}
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
  const stagePath = writeStage(bootstrapRoot, subject.head, bytes);
  try {
    const stage = await loadStage(stagePath);
    if (typeof stage?.installDevBridge !== 'function' || typeof stage?.runInstalledSetup !== 'function') {
      fail('Bootstrap stage contract is unavailable.');
    }
    const prepared = await prepareSource(stage, subject, { fetcher, bootstrapRoot });
    try {
      const installed = stage.installDevBridge({
        home: subject.home,
        selector: Object.freeze({ kind: 'exact', value: subject.head }),
        pinSelectedRunner: options.explicitSelector,
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
    try { rmSync(stagePath, { force: true }); } catch {}
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
