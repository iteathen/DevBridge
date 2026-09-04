import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  UBUNTU_PACKAGE_CAPSULE_TRANSACTION_PROTOCOL,
  UBUNTU_PACKAGE_STATE_PROTOCOL,
} from '../setup/ubuntu-package-capsule-release-input.mjs';
import {
  sameFilesystemIdentity,
  sameObservedFilesystemIdentity,
} from '../runtime/local-filesystem-identity.js';
import { comparePackageVersions } from '../setup/package-version.js';

export const UBUNTU_APT_TRANSACTION_SOLUTION_PROTOCOL = 'devbridge/ubuntu-apt-transaction-solution-v1';
export const UBUNTU_APT_ISOLATED_CONFIGURATION = 'Dir::Etc::main "/dev/null";\nDir::Etc::parts "/dev/null";\n';

const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const ARCHITECTURE = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,99}$/u;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,199}$/u;
const MUTABLE_VERSION = /^(?:latest|stable|current|head|main|master)$/iu;
const MAX_REQUESTED_PACKAGES = 256;
const MAX_SELECTED_PACKAGES = 8192;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;
const MAX_CONFIGURATION_BYTES = 1024 * 1024;
const MAX_LIST_FILE_BYTES = 512 * 1024 * 1024;
const MAX_LIST_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_LIST_FILES = 64;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 512 * 1024;

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function packageName(value, context) {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) throw new TypeError(`${context} is invalid`);
  return value;
}

function packageVersion(value, context) {
  if (typeof value !== 'string' || !PACKAGE_VERSION.test(value) || !/\d/u.test(value) || MUTABLE_VERSION.test(value)) {
    throw new TypeError(`${context} is invalid`);
  }
  return value;
}

function architecture(value, context) {
  if (typeof value !== 'string' || !ARCHITECTURE.test(value)) throw new TypeError(`${context} is invalid`);
  return value;
}

function packageIdentity(item) { return `${item.package}\0${item.architecture}`; }

function canonicalPackages(raw, context, { allowEmpty = false } = {}) {
  if (!Array.isArray(raw) || (!allowEmpty && raw.length < 1) || raw.length > MAX_SELECTED_PACKAGES) {
    throw new TypeError(`${context} is invalid`);
  }
  const identities = new Set();
  return Object.freeze(raw.map((entry, index) => {
    const item = exactObject(entry, new Set(['package', 'version', 'architecture']), `${context}[${index}]`);
    const normalized = Object.freeze({
      package: packageName(item.package, `${context}[${index}].package`),
      version: packageVersion(item.version, `${context}[${index}].version`),
      architecture: architecture(item.architecture, `${context}[${index}].architecture`),
    });
    const identity = packageIdentity(normalized);
    if (identities.has(identity)) throw new TypeError(`${context} identities must be unique`);
    identities.add(identity);
    return normalized;
  }).sort((left, right) => compareText(left.package, right.package)
    || compareText(left.architecture, right.architecture)
    || compareText(left.version, right.version)));
}

export function ubuntuPackageStateSha256(rawPackages) {
  const packages = canonicalPackages(rawPackages, 'Ubuntu installed package state', { allowEmpty: true });
  return sha256(Buffer.from(JSON.stringify({ protocol: UBUNTU_PACKAGE_STATE_PROTOCOL, packages }), 'utf8'));
}

function normalizeRequested(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_REQUESTED_PACKAGES) {
    throw new TypeError('Ubuntu requested package names are invalid');
  }
  const seen = new Set();
  return Object.freeze(raw.map((value, index) => {
    const name = packageName(value, `Ubuntu requested package ${index}`);
    if (seen.has(name)) throw new TypeError('Ubuntu requested package names must be unique');
    seen.add(name);
    return name;
  }).sort(compareText));
}

function normalizeSolution(raw, expected = null) {
  const value = exactObject(raw, new Set([
    'protocol', 'snapshot', 'architecture', 'basePackages', 'resultPackages',
    'selectedPackages', 'requestedPackages', 'transaction',
  ]), 'Ubuntu APT transaction solution');
  if (value.protocol !== UBUNTU_APT_TRANSACTION_SOLUTION_PROTOCOL) fail('Ubuntu APT transaction solution protocol is unsupported');
  if (typeof value.snapshot !== 'string' || !SNAPSHOT.test(value.snapshot)) throw new TypeError('Ubuntu APT transaction snapshot is invalid');
  const selectedArchitecture = architecture(value.architecture, 'Ubuntu APT transaction architecture');
  if (expected && (value.snapshot !== expected.snapshot || selectedArchitecture !== expected.architecture)) {
    fail('Ubuntu APT transaction solution does not match its request');
  }
  const basePackages = canonicalPackages(value.basePackages, 'Ubuntu APT base package state');
  const resultPackages = canonicalPackages(value.resultPackages, 'Ubuntu APT result package state');
  const selectedPackages = canonicalPackages(value.selectedPackages, 'Ubuntu APT selected packages');
  const requestedPackages = canonicalPackages(value.requestedPackages, 'Ubuntu APT requested packages');
  const base = new Map(basePackages.map((entry) => [packageIdentity(entry), entry]));
  const result = new Map(resultPackages.map((entry) => [packageIdentity(entry), entry]));
  const selected = new Map(selectedPackages.map((entry) => [packageIdentity(entry), entry]));
  for (const [identity, item] of base) {
    if (!result.has(identity)) fail(`Ubuntu APT transaction removes ${item.package}:${item.architecture}`);
    const after = result.get(identity);
    if (comparePackageVersions(after.version, item.version) < 0) {
      fail(`Ubuntu APT transaction downgrades ${item.package}:${item.architecture}`);
    }
  }
  for (const [identity, item] of result) {
    const before = base.get(identity);
    if (before?.version === item.version) continue;
    const planned = selected.get(identity);
    if (!planned || planned.version !== item.version) fail(`Ubuntu APT result change for ${item.package}:${item.architecture} is not selected`);
  }
  for (const item of selectedPackages) {
    if (result.get(packageIdentity(item))?.version !== item.version) {
      fail(`Ubuntu APT selected package ${item.package}:${item.architecture} is absent from the result state`);
    }
  }
  const requestedNames = expected?.requestedPackages ?? requestedPackages.map((item) => item.package);
  if (requestedPackages.length !== requestedNames.length) fail('Ubuntu APT requested package result is incomplete');
  for (const name of requestedNames) {
    const matches = requestedPackages.filter((item) => item.package === name);
    if (matches.length !== 1 || result.get(packageIdentity(matches[0]))?.version !== matches[0].version) {
      fail(`Ubuntu APT requested package ${name} is not exact in the result state`);
    }
  }
  const transaction = Object.freeze({
    protocol: UBUNTU_PACKAGE_CAPSULE_TRANSACTION_PROTOCOL,
    packageStateProtocol: UBUNTU_PACKAGE_STATE_PROTOCOL,
    basePackageStateSha256: ubuntuPackageStateSha256(basePackages),
    resultPackageStateSha256: ubuntuPackageStateSha256(resultPackages),
    requestedPackages: Object.freeze(requestedPackages.map((item) => Object.freeze({ name: item.package, version: item.version }))),
  });
  if (value.transaction != null) {
    const supplied = exactObject(value.transaction, new Set([
      'protocol', 'packageStateProtocol', 'basePackageStateSha256', 'resultPackageStateSha256', 'requestedPackages',
    ]), 'Ubuntu APT transaction solution derived transaction');
    if (supplied.protocol !== transaction.protocol || supplied.packageStateProtocol !== transaction.packageStateProtocol
        || supplied.basePackageStateSha256 !== transaction.basePackageStateSha256
        || supplied.resultPackageStateSha256 !== transaction.resultPackageStateSha256
        || !Array.isArray(supplied.requestedPackages)
        || supplied.requestedPackages.length !== transaction.requestedPackages.length) {
      fail('Ubuntu APT transaction solution derived transaction does not match its package states');
    }
    for (let index = 0; index < transaction.requestedPackages.length; index += 1) {
      const item = exactObject(supplied.requestedPackages[index], new Set(['name', 'version']), `Ubuntu APT transaction solution derived requested package ${index}`);
      if (item.name !== transaction.requestedPackages[index].name || item.version !== transaction.requestedPackages[index].version) {
        fail('Ubuntu APT transaction solution derived transaction does not match its package states');
      }
    }
  }
  return Object.freeze({
    protocol: UBUNTU_APT_TRANSACTION_SOLUTION_PROTOCOL,
    snapshot: value.snapshot,
    architecture: selectedArchitecture,
    basePackages,
    resultPackages,
    selectedPackages,
    requestedPackages,
    transaction,
  });
}

export function normalizeUbuntuAptTransactionSolution(raw) { return normalizeSolution(raw); }

function parseControlParagraphs(text, context) {
  const result = [];
  const normalized = text.replaceAll('\r\n', '\n');
  for (const [index, paragraph] of normalized.split(/\n\s*\n/u).entries()) {
    if (!paragraph.trim()) continue;
    const fields = new Map();
    let current = null;
    for (const line of paragraph.split('\n')) {
      if (line === '') continue;
      if (/^[ \t]/u.test(line)) {
        if (!current) fail(`${context} continuation has no field`);
        fields.set(current, `${fields.get(current)}\n${line}`);
        continue;
      }
      const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]?(.*)$/u.exec(line);
      if (!match || fields.has(match[1])) fail(`${context} paragraph ${index} is invalid`);
      current = match[1];
      fields.set(current, match[2]);
    }
    result.push(fields);
  }
  return result;
}

export function parseUbuntuInstalledPackageState(statusBytes) {
  if (!(statusBytes instanceof Uint8Array) || statusBytes.byteLength < 1 || statusBytes.byteLength > MAX_STATUS_BYTES) {
    throw new TypeError('Ubuntu dpkg status bytes are invalid');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(statusBytes); }
  catch { fail('Ubuntu dpkg status is not valid UTF-8'); }
  const packages = [];
  for (const stanza of parseControlParagraphs(text, 'Ubuntu dpkg status')) {
    if (stanza.get('Status') !== 'install ok installed') continue;
    packages.push({
      package: packageName(stanza.get('Package'), 'Ubuntu dpkg status Package'),
      version: packageVersion(stanza.get('Version'), 'Ubuntu dpkg status Version'),
      architecture: architecture(stanza.get('Architecture'), 'Ubuntu dpkg status Architecture'),
    });
  }
  return canonicalPackages(packages, 'Ubuntu installed package state');
}

export function parseUbuntuAptSimulation(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_STDOUT_BYTES || output.includes('\0')) {
    throw new TypeError('Ubuntu APT simulation output is invalid');
  }
  const packages = [];
  for (const line of output.replaceAll('\r\n', '\n').split('\n')) {
    if (!line) continue;
    if (line.startsWith('Conf ')) {
      if (!/^Conf [a-z0-9][a-z0-9+.-]{0,99}(?::[a-z0-9][a-z0-9-]{0,31})? \([^\r\n()]+\)$/u.test(line)) {
        fail(`Ubuntu APT simulation emitted unsupported output: ${line}`);
      }
      continue;
    }
    if (line.startsWith('Remv ')) fail('Ubuntu APT simulation requested package removal');
    const match = /^Inst ([a-z0-9][a-z0-9+.-]{0,99})(?::([a-z0-9][a-z0-9-]{0,31}))?(?: \[[^\]\r\n]+\])? \(([^ ()\r\n]+)(?: [^\r\n]*)? \[([a-z0-9][a-z0-9-]{0,31})\]\)$/u.exec(line);
    if (!match) fail(`Ubuntu APT simulation emitted unsupported output: ${line}`);
    const selectedArchitecture = match[2] ?? match[4];
    if (match[2] && match[2] !== match[4] && match[4] !== 'all') {
      fail(`Ubuntu APT simulation architecture disagrees for ${match[1]}`);
    }
    packages.push({ package: match[1], version: match[3], architecture: selectedArchitecture });
  }
  return canonicalPackages(packages, 'Ubuntu APT simulation packages', { allowEmpty: true });
}

function sameObservation(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function relativeChild(root, selected, context) {
  const relative = path.relative(root, selected);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(`${context} must be inside the Ubuntu APT workspace`);
}

async function directEntry(location, context, kind, maximum = null) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || /[\u0000-\u001f\u007f]/u.test(location)) {
    throw new TypeError(`${context} path is invalid`);
  }
  const selected = path.resolve(location);
  if (!await sameFilesystemIdentity(selected, await realpath(selected))) fail(`${context} must use a direct nonsymbolic path`);
  const info = await lstat(selected, { bigint: true });
  if (kind === 'file' && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
      || info.size < 1n || info.size > BigInt(maximum))) fail(`${context} must be one bounded unlinked regular file`);
  if (kind === 'directory' && (!info.isDirectory() || info.isSymbolicLink())) fail(`${context} must be one direct directory`);
  return Object.freeze({ location: selected, info });
}

async function directFiles(directory, context, { allowEmpty, maximumFiles, maximumFileBytes, maximumBytes }) {
  const entries = await readdir(directory.location, { withFileTypes: true });
  if ((!allowEmpty && entries.length < 1) || entries.length > maximumFiles) fail(`${context} entry count is invalid`);
  let total = 0n;
  const files = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name === '.' || entry.name === '..') fail(`${context} contains an unsupported entry`);
    const selected = path.join(directory.location, entry.name);
    const file = await directEntry(selected, `${context}/${entry.name}`, 'file', maximumFileBytes);
    total += file.info.size;
    if (total > BigInt(maximumBytes)) fail(`${context} exceeds its total size bound`);
    files.push(file);
  }
  return Object.freeze(files);
}

function runApt(executable, args, environment, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
      signal: signal ?? undefined,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const collect = (target, field, maximum) => (chunk) => {
      if (field === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if ((field === 'stdout' ? stdoutBytes : stderrBytes) > maximum) { overflow = true; child.kill(); return; }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout, 'stdout', MAX_STDOUT_BYTES));
    child.stderr.on('data', collect(stderr, 'stderr', MAX_STDERR_BYTES));
    child.once('error', reject);
    child.once('close', (code, childSignal) => {
      if (overflow) { reject(new Error('Ubuntu APT simulation output exceeded its bound')); return; }
      resolve(Object.freeze({
        code,
        signal: childSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    });
  });
}

function commonArguments(request) {
  return [
    '-o', `Dir::State::status=${request.statusFile}`,
    '-o', `Dir::State::lists=${request.listsDirectory}`,
    '-o', `Dir::Etc::sourcelist=${request.sourcesListFile}`,
    '-o', `Dir::Etc::sourceparts=${request.sourcePartsDirectory}`,
    '-o', 'Dir::Etc::preferences=/dev/null',
    '-o', 'Dir::Etc::preferencesparts=/dev/null',
    '-o', 'Dir::State::extended_states=/dev/null',
    '-o', 'Dir::Cache::pkgcache=',
    '-o', 'Dir::Cache::srcpkgcache=',
    '-o', 'Debug::NoLocking=true',
    '-o', 'APT::Install-Recommends=false',
    '-o', 'APT::Install-Suggests=false',
    '-o', 'APT::Get::Show-User-Simulation-Note=false',
    '-o', 'APT::Solver=internal',
    '-o', `APT::Architecture=${request.architecture}`,
    '--snapshot', request.snapshot,
    '--simulate', '--quiet=2',
  ];
}

function environmentFor(configurationFile) {
  const environment = { LANG: 'C', LC_ALL: 'C', APT_CONFIG: configurationFile };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function argumentBytes(args) { return args.reduce((total, value) => total + Buffer.byteLength(value, 'utf8') + 1, 0); }

function aptFailure(label, result) {
  const code = Number.isInteger(result?.code) ? result.code : 'invalid';
  const childSignal = typeof result?.signal === 'string' && result.signal ? `, signal ${result.signal}` : '';
  const detail = typeof result?.stderr === 'string'
    ? result.stderr.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '?').slice(-2048)
    : '';
  return `${label} failed (exit ${code}${childSignal})${detail ? `: ${detail}` : ''}`;
}

async function observeInputs(options, request) {
  const workspace = await directEntry(request.workspace, 'Ubuntu APT workspace', 'directory');
  const [executable, configurationFile, statusFile, sourcesListFile, sourcePartsDirectory, listsDirectory] = await Promise.all([
    directEntry(options.executable, 'apt-get executable', 'file', 128 * 1024 * 1024),
    directEntry(request.configurationFile, 'Ubuntu APT configuration', 'file', MAX_CONFIGURATION_BYTES),
    directEntry(request.statusFile, 'Ubuntu dpkg status', 'file', MAX_STATUS_BYTES),
    directEntry(request.sourcesListFile, 'Ubuntu APT sources list', 'file', MAX_CONFIGURATION_BYTES),
    directEntry(request.sourcePartsDirectory, 'Ubuntu APT source-parts directory', 'directory'),
    directEntry(request.listsDirectory, 'Ubuntu APT lists directory', 'directory'),
  ]);
  for (const entry of [configurationFile, statusFile, sourcesListFile, sourcePartsDirectory, listsDirectory]) {
    relativeChild(workspace.location, entry.location, 'Ubuntu APT input');
  }
  const [sourceParts, lists] = await Promise.all([
    directFiles(sourcePartsDirectory, 'Ubuntu APT source-parts directory', {
      allowEmpty: true, maximumFiles: 16, maximumFileBytes: MAX_CONFIGURATION_BYTES, maximumBytes: 4 * MAX_CONFIGURATION_BYTES,
    }),
    directFiles(listsDirectory, 'Ubuntu APT lists directory', {
      allowEmpty: false, maximumFiles: MAX_LIST_FILES, maximumFileBytes: MAX_LIST_FILE_BYTES, maximumBytes: MAX_LIST_BYTES,
    }),
  ]);
  return Object.freeze({ workspace, executable, configurationFile, statusFile, sourcesListFile, sourcePartsDirectory, listsDirectory, sourceParts, lists });
}

async function reobserve(observed) {
  for (const entry of [
    observed.workspace, observed.executable, observed.configurationFile, observed.statusFile,
    observed.sourcesListFile, observed.sourcePartsDirectory, observed.listsDirectory,
    ...observed.sourceParts, ...observed.lists,
  ]) {
    const after = await lstat(entry.location, { bigint: true });
    if (!sameObservation(entry.info, after)) fail('Ubuntu APT executable or input state changed during solving');
  }
  for (const [directory, before] of [[observed.sourcePartsDirectory, observed.sourceParts], [observed.listsDirectory, observed.lists]]) {
    const names = (await readdir(directory.location)).sort(compareText);
    const expected = before.map((entry) => path.basename(entry.location));
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      fail('Ubuntu APT input inventory changed during solving');
    }
  }
}

export class UbuntuAptTransactionSolver {
  constructor(raw = {}) {
    const { executable, run = runApt } = exactObject(raw, new Set(['executable', 'run']), 'Ubuntu APT solver options');
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\u0000-\u001f\u007f]/u.test(executable)) {
      throw new TypeError('apt-get executable path is invalid');
    }
    if (typeof run !== 'function') throw new TypeError('Ubuntu APT runner port is invalid');
    this.executable = path.resolve(executable);
    this.run = run;
  }

  async solve(raw = {}) {
    const request = exactObject(raw, new Set([
      'workspace', 'configurationFile', 'statusFile', 'sourcesListFile', 'sourcePartsDirectory',
      'listsDirectory', 'snapshot', 'architecture', 'requestedPackages', 'signal',
    ]), 'Ubuntu APT solver request');
    if (typeof request.snapshot !== 'string' || !SNAPSHOT.test(request.snapshot)) throw new TypeError('Ubuntu APT snapshot is invalid');
    const selectedArchitecture = architecture(request.architecture, 'Ubuntu APT architecture');
    const requestedPackages = normalizeRequested(request.requestedPackages);
    if (request.signal != null && typeof request.signal !== 'object') throw new TypeError('Ubuntu APT solver signal is invalid');
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('Ubuntu APT solving was interrupted');
    const observed = await observeInputs({ executable: this.executable }, request);
    const statusBytes = await readFile(observed.statusFile.location);
    const basePackages = parseUbuntuInstalledPackageState(statusBytes);
    const configurationBytes = await readFile(observed.configurationFile.location);
    if (!configurationBytes.equals(Buffer.from(UBUNTU_APT_ISOLATED_CONFIGURATION, 'utf8'))) {
      fail('Ubuntu APT configuration does not disable host configuration loading');
    }
    const normalizedRequest = Object.freeze({
      ...request,
      snapshot: request.snapshot,
      architecture: selectedArchitecture,
      requestedPackages,
      workspace: observed.workspace.location,
      configurationFile: observed.configurationFile.location,
      statusFile: observed.statusFile.location,
      sourcesListFile: observed.sourcesListFile.location,
      sourcePartsDirectory: observed.sourcePartsDirectory.location,
      listsDirectory: observed.listsDirectory.location,
    });
    const common = commonArguments(normalizedRequest);
    const environment = environmentFor(normalizedRequest.configurationFile);
    const upgradeArgs = [...common, '--with-new-pkgs', '--no-remove', 'upgrade'];
    const upgrade = await this.run(observed.executable.location, upgradeArgs, environment, request.signal);
    if (!upgrade || upgrade.code !== 0 || upgrade.signal != null || typeof upgrade.stdout !== 'string' || typeof upgrade.stderr !== 'string'
        || Buffer.byteLength(upgrade.stderr, 'utf8') > MAX_STDERR_BYTES || upgrade.stderr.trim() !== '') {
      fail(aptFailure('Ubuntu APT no-removal upgrade simulation', upgrade));
    }
    const upgradePackages = parseUbuntuAptSimulation(upgrade.stdout);
    const specifications = upgradePackages.map((item) => `${item.package}:${item.architecture}=${item.version}`);
    const installArgs = [...common, '--no-remove', '--no-install-recommends', 'install', ...specifications, ...requestedPackages];
    if (argumentBytes(installArgs) > MAX_ARGUMENT_BYTES) fail('Ubuntu APT combined transaction arguments exceed their bound');
    const install = await this.run(observed.executable.location, installArgs, environment, request.signal);
    if (!install || install.code !== 0 || install.signal != null || typeof install.stdout !== 'string' || typeof install.stderr !== 'string'
        || Buffer.byteLength(install.stderr, 'utf8') > MAX_STDERR_BYTES || install.stderr.trim() !== '') {
      fail(aptFailure('Ubuntu APT combined transaction simulation', install));
    }
    const installed = parseUbuntuAptSimulation(install.stdout);
    const selectedByIdentity = new Map(installed.map((entry) => [packageIdentity(entry), entry]));
    for (const item of upgradePackages) {
      if (selectedByIdentity.get(packageIdentity(item))?.version !== item.version) {
        fail(`Ubuntu APT combined transaction changed the no-removal upgrade selection for ${item.package}`);
      }
    }
    const resultByIdentity = new Map(basePackages.map((entry) => [packageIdentity(entry), entry]));
    for (const item of installed) resultByIdentity.set(packageIdentity(item), item);
    const resultPackages = canonicalPackages([...resultByIdentity.values()], 'Ubuntu APT result package state');
    const requested = requestedPackages.map((name) => {
      const matches = resultPackages.filter((item) => item.package === name
        && (item.architecture === selectedArchitecture || item.architecture === 'all'));
      if (matches.length !== 1) fail(`Ubuntu APT requested package ${name} does not resolve to one result package`);
      return matches[0];
    });
    const selectedDownloads = new Map(installed.map((entry) => [packageIdentity(entry), entry]));
    for (const item of requested) selectedDownloads.set(packageIdentity(item), item);
    await reobserve(observed);
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('Ubuntu APT solving was interrupted');
    return normalizeSolution({
      protocol: UBUNTU_APT_TRANSACTION_SOLUTION_PROTOCOL,
      snapshot: request.snapshot,
      architecture: selectedArchitecture,
      basePackages,
      resultPackages,
      selectedPackages: [...selectedDownloads.values()],
      requestedPackages: requested,
    }, { snapshot: request.snapshot, architecture: selectedArchitecture, requestedPackages });
  }
}
