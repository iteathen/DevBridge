import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeUbuntuInstallationSource } from '../setup/ubuntu-package-capsule-release-input.mjs';
import {
  UBUNTU_APT_ISOLATED_CONFIGURATION,
  parseUbuntuInstalledPackageState,
  ubuntuPackageStateSha256,
} from './ubuntu-apt-transaction-solver.mjs';
import {
  sameFilesystemIdentity,
  sameObservedFilesystemIdentity,
} from '../runtime/local-filesystem-identity.js';

export const UBUNTU_CAPSULE_SOLVER_INPUT_PREPARATION_PROTOCOL =
  'devbridge/ubuntu-capsule-solver-input-preparation-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const TOKEN = /^[a-z0-9][a-z0-9.-]{0,99}$/u;
const ARCHITECTURE = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,99}$/u;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;
const MAX_KEYRING_BYTES = 1024 * 1024;
const MAX_CONFIGURATION_BYTES = 1024 * 1024;
const MAX_LIST_FILES = 16;
const MAX_LIST_FILE_BYTES = 512 * 1024 * 1024;
const MAX_LIST_BYTES = 2 * 1024 * 1024 * 1024;

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function exactString(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid`);
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return path.resolve(value);
}

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function sameObservation(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readDirectFile(location, context, maximum) {
  const selected = absolutePath(location, `${context} path`);
  if (!await sameFilesystemIdentity(selected, await realpath(selected))) fail(`${context} must use a direct nonsymbolic path`);
  const before = await lstat(selected, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maximum)) {
    fail(`${context} must be one bounded unlinked regular file`);
  }
  const handle = await open(selected, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!sameObservation(before, held)) fail(`${context} changed while opening`);
    const bytes = await handle.readFile();
    const after = await lstat(selected, { bigint: true });
    if (bytes.byteLength !== Number(before.size) || !sameObservation(held, after)) fail(`${context} changed while reading`);
    return Object.freeze({
      location: selected,
      bytes,
      observation: Object.freeze({
        device: String(after.dev), inode: String(after.ino), size: Number(after.size),
        mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs),
      }),
      sha256: sha256(bytes),
    });
  } finally { await handle.close(); }
}

async function hashDirectFile(location, context, maximum) {
  const selected = absolutePath(location, `${context} path`);
  if (!await sameFilesystemIdentity(selected, await realpath(selected))) fail(`${context} must use a direct nonsymbolic path`);
  const before = await lstat(selected, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maximum)) {
    fail(`${context} must be one bounded unlinked regular file`);
  }
  const handle = await open(selected, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!sameObservation(before, held)) fail(`${context} changed while opening`);
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.byteLength;
      if (bytes > maximum) fail(`${context} exceeds its byte bound`);
      digest.update(chunk);
    }
    const after = await lstat(selected, { bigint: true });
    if (bytes !== Number(before.size) || !sameObservation(held, after)) fail(`${context} changed while hashing`);
    return Object.freeze({
      location: selected,
      bytes,
      observation: Object.freeze({
        device: String(after.dev), inode: String(after.ino), size: Number(after.size),
        mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs),
      }),
      sha256: digest.digest('hex'),
    });
  } finally { await handle.close(); }
}

async function directDirectory(location, root, context) {
  const selected = absolutePath(location, `${context} path`);
  const relative = path.relative(root, selected);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(`${context} must be inside the preparation workspace`);
  if (!await sameFilesystemIdentity(selected, await realpath(selected))) fail(`${context} must use a direct nonsymbolic path`);
  const info = await lstat(selected, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${context} must be one direct directory`);
  return Object.freeze({ location: selected, info });
}

function normalizeRequested(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 256) throw new TypeError('Ubuntu requested packages are invalid');
  const values = raw.map((value, index) => exactString(value, PACKAGE, `Ubuntu requested package ${index}`));
  if (new Set(values).size !== values.length) throw new TypeError('Ubuntu requested packages must be unique');
  return Object.freeze(values.sort(compareText));
}

function normalizeLayers(raw, leafLayer) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) throw new TypeError('Ubuntu installer ordered layers are invalid');
  const names = raw.map((value, index) => exactString(value, TOKEN, `Ubuntu installer layer ${index}`));
  if (new Set(names).size !== names.length || names.at(-1) !== leafLayer) fail('Ubuntu installer ordered layers do not terminate at the declared leaf');
  return Object.freeze(names);
}

async function observeLayers(raw, names, destination, maximum) {
  if (!Array.isArray(raw) || raw.length !== names.length) throw new TypeError('Ubuntu installer layer files are invalid');
  const observed = [];
  for (let index = 0; index < names.length; index += 1) {
    const value = exactObject(raw[index], new Set(['name', 'location']), `Ubuntu installer layer file ${index}`);
    if (value.name !== names[index]) fail('Ubuntu installer layer file order does not match its authority');
    const file = await hashDirectFile(value.location, `Ubuntu installer layer ${value.name}`, maximum);
    const relative = path.relative(destination, file.location);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('Ubuntu installer layer escaped its preparation workspace');
    observed.push(Object.freeze({ name: value.name, bytes: file.bytes, sha256: file.sha256 }));
  }
  return Object.freeze(observed);
}

export function ubuntuSnapshotSources({ codename, architecture, keyring }) {
  const selectedCodename = exactString(codename, TOKEN, 'Ubuntu codename');
  const selectedArchitecture = exactString(architecture, ARCHITECTURE, 'Ubuntu architecture');
  const selectedKeyring = absolutePath(keyring, 'Ubuntu archive keyring path');
  const options = `arch=${selectedArchitecture} snapshot=yes signed-by=${selectedKeyring}`;
  return [
    `deb [${options}] http://archive.ubuntu.com/ubuntu ${selectedCodename} main universe`,
    `deb [${options}] http://archive.ubuntu.com/ubuntu ${selectedCodename}-updates main universe`,
    `deb [${options}] http://security.ubuntu.com/ubuntu ${selectedCodename}-security main universe`,
    '',
  ].join('\n');
}

function expectedListNames(snapshot, codename, architecture) {
  const prefix = `snapshot.ubuntu.com_ubuntu_${snapshot}_dists_`;
  return Object.freeze([
    `${prefix}${codename}-security_InRelease`,
    `${prefix}${codename}-security_main_binary-${architecture}_Packages`,
    `${prefix}${codename}-security_universe_binary-${architecture}_Packages`,
    `${prefix}${codename}-updates_InRelease`,
    `${prefix}${codename}-updates_main_binary-${architecture}_Packages`,
    `${prefix}${codename}-updates_universe_binary-${architecture}_Packages`,
    `${prefix}${codename}_InRelease`,
    `${prefix}${codename}_main_binary-${architecture}_Packages`,
    `${prefix}${codename}_universe_binary-${architecture}_Packages`,
  ].sort(compareText));
}

async function observeListInventory(directory, expected) {
  const names = (await readdir(directory.location)).sort(compareText);
  if (names.length !== expected.length || names.length > MAX_LIST_FILES
      || names.some((name, index) => name !== expected[index])) {
    fail('Ubuntu snapshot list inventory does not match the exact retained projection');
  }
  let total = 0;
  const files = [];
  for (const name of names) {
    const file = await readDirectFile(path.join(directory.location, name), `Ubuntu snapshot list ${name}`, MAX_LIST_FILE_BYTES);
    total += file.bytes.byteLength;
    if (total > MAX_LIST_BYTES) fail('Ubuntu snapshot list inventory exceeds its total byte bound');
    files.push(Object.freeze({ name, bytes: file.bytes.byteLength, sha256: file.sha256 }));
  }
  return Object.freeze(files);
}

function inventorySha256(files) {
  return sha256(Buffer.from(JSON.stringify({
    protocol: 'devbridge/ubuntu-snapshot-list-inventory-v1', files,
  }), 'utf8'));
}

function sameValues(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function observeDirectIdentity(location, context) {
  const selected = absolutePath(location, `${context} path`);
  if (!await sameFilesystemIdentity(selected, await realpath(selected))) fail(`${context} must use a direct nonsymbolic path`);
  const info = await lstat(selected, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 1n) {
    fail(`${context} must be one unlinked regular file`);
  }
  return Object.freeze({
    location: selected,
    observation: Object.freeze({
      device: String(info.dev), inode: String(info.ino), size: Number(info.size),
      mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs),
    }),
  });
}

function exactObservation(raw, context) {
  const value = exactObject(raw, new Set(['device', 'inode', 'size', 'mtimeNs', 'ctimeNs']), `${context} observation`);
  for (const name of ['device', 'inode', 'mtimeNs', 'ctimeNs']) {
    if (typeof value[name] !== 'string' || !/^\d+$/u.test(value[name])) throw new TypeError(`${context} observation is invalid`);
  }
  positiveInteger(value.size, `${context} observed byte count`);
  return value;
}

function observationsEqual(left, right) {
  return left.device === right.device && left.inode === right.inode && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function verifyUbuntuCapsuleSolverInputPreparation(raw, rawPolicy) {
  const prepared = exactObject(raw, new Set(['protocol', 'root', 'receiptFile', 'receipt', 'solverRequest']), 'Ubuntu solver-input preparation');
  if (prepared.protocol !== UBUNTU_CAPSULE_SOLVER_INPUT_PREPARATION_PROTOCOL) fail('Ubuntu solver-input preparation protocol is unsupported');
  const policy = exactObject(rawPolicy, new Set([
    'distribution', 'release', 'codename', 'architecture', 'snapshot', 'baseMediaSha256', 'installSource',
    'releaseId', 'sequence', 'upstreamKeyFingerprint',
  ]), 'Ubuntu package-capsule production policy');
  const root = absolutePath(prepared.root, 'Ubuntu solver-input preparation root');
  const receiptFile = absolutePath(prepared.receiptFile, 'Ubuntu solver-input preparation receipt');
  if (receiptFile !== path.join(root, 'preparation-receipt.json')) fail('Ubuntu solver-input preparation receipt path is invalid');
  const receipt = exactObject(prepared.receipt, new Set([
    'protocol', 'distribution', 'release', 'codename', 'architecture', 'snapshot',
    'media', 'installer', 'apt', 'requestedPackages',
  ]), 'Ubuntu solver-input preparation receipt');
  if (receipt.protocol !== UBUNTU_CAPSULE_SOLVER_INPUT_PREPARATION_PROTOCOL
      || receipt.distribution !== policy.distribution || receipt.release !== policy.release
      || receipt.codename !== policy.codename || receipt.architecture !== policy.architecture
      || receipt.snapshot !== policy.snapshot) {
    fail('Ubuntu solver-input preparation receipt does not match production policy');
  }
  exactString(receipt.distribution, TOKEN, 'Ubuntu solver-input preparation distribution');
  exactString(receipt.release, TOKEN, 'Ubuntu solver-input preparation release');
  exactString(receipt.codename, TOKEN, 'Ubuntu solver-input preparation codename');
  exactString(receipt.architecture, ARCHITECTURE, 'Ubuntu solver-input preparation architecture');
  exactString(receipt.snapshot, SNAPSHOT, 'Ubuntu solver-input preparation snapshot');
  const media = exactObject(receipt.media, new Set(['location', 'bytes', 'sha256', 'observation']), 'Ubuntu solver-input preparation media');
  const mediaLocation = absolutePath(media.location, 'Ubuntu solver-input preparation media');
  const mediaBytes = positiveInteger(media.bytes, 'Ubuntu solver-input preparation media byte count');
  const mediaSha256 = exactString(media.sha256, SHA256, 'Ubuntu solver-input preparation media SHA-256');
  const mediaObservation = exactObservation(media.observation, 'Ubuntu solver-input preparation media');
  if (mediaSha256 !== policy.baseMediaSha256 || mediaBytes !== mediaObservation.size) {
    fail('Ubuntu solver-input preparation media does not match production policy');
  }
  const currentMedia = await observeDirectIdentity(mediaLocation, 'Ubuntu solver-input preparation media');
  if (!observationsEqual(mediaObservation, currentMedia.observation)) fail('Ubuntu solver-input preparation media changed after preparation');

  const installer = exactObject(receipt.installer, new Set([
    'installSource', 'leafLayer', 'orderedLayers', 'statusLayer', 'statusBytes', 'statusSha256',
    'basePackageStateSha256', 'keyringLayer', 'keyringBytes', 'keyringSha256',
  ]), 'Ubuntu solver-input preparation installer evidence');
  const installSource = normalizeUbuntuInstallationSource(installer.installSource);
  if (installSource !== normalizeUbuntuInstallationSource(policy.installSource)) fail('Ubuntu solver-input preparation installation source does not match production policy');
  const leafLayer = exactString(installer.leafLayer, TOKEN, 'Ubuntu solver-input preparation leaf layer');
  if (!Array.isArray(installer.orderedLayers) || installer.orderedLayers.length < 1 || installer.orderedLayers.length > 16) {
    throw new TypeError('Ubuntu solver-input preparation ordered layer evidence is invalid');
  }
  const layerNames = [];
  for (let index = 0; index < installer.orderedLayers.length; index += 1) {
    const layer = exactObject(installer.orderedLayers[index], new Set(['name', 'bytes', 'sha256']), `Ubuntu solver-input preparation layer ${index}`);
    layerNames.push(exactString(layer.name, TOKEN, `Ubuntu solver-input preparation layer ${index} name`));
    positiveInteger(layer.bytes, `Ubuntu solver-input preparation layer ${index} byte count`);
    exactString(layer.sha256, SHA256, `Ubuntu solver-input preparation layer ${index} SHA-256`);
  }
  exactString(installer.statusLayer, TOKEN, 'Ubuntu solver-input preparation status layer');
  exactString(installer.keyringLayer, TOKEN, 'Ubuntu solver-input preparation keyring layer');
  if (new Set(layerNames).size !== layerNames.length || layerNames.at(-1) !== leafLayer
      || !layerNames.includes(installer.statusLayer) || !layerNames.includes(installer.keyringLayer)) {
    fail('Ubuntu solver-input preparation layer evidence is inconsistent');
  }
  const statusBytes = positiveInteger(installer.statusBytes, 'Ubuntu solver-input preparation status byte count');
  const statusSha256 = exactString(installer.statusSha256, SHA256, 'Ubuntu solver-input preparation status SHA-256');
  const basePackageStateSha256 = exactString(installer.basePackageStateSha256, SHA256, 'Ubuntu solver-input preparation base state SHA-256');
  const keyringBytes = positiveInteger(installer.keyringBytes, 'Ubuntu solver-input preparation keyring byte count');
  const keyringSha256 = exactString(installer.keyringSha256, SHA256, 'Ubuntu solver-input preparation keyring SHA-256');

  const apt = exactObject(receipt.apt, new Set([
    'configurationSha256', 'sourcesSha256', 'listInventorySha256', 'lists',
  ]), 'Ubuntu solver-input preparation APT evidence');
  const configurationSha256 = exactString(apt.configurationSha256, SHA256, 'Ubuntu solver-input preparation configuration SHA-256');
  const sourcesSha256 = exactString(apt.sourcesSha256, SHA256, 'Ubuntu solver-input preparation sources SHA-256');
  const listInventorySha256 = exactString(apt.listInventorySha256, SHA256, 'Ubuntu solver-input preparation list inventory SHA-256');
  if (!Array.isArray(apt.lists) || apt.lists.length !== 9) throw new TypeError('Ubuntu solver-input preparation list evidence is invalid');
  const recordedLists = apt.lists.map((rawList, index) => {
    const item = exactObject(rawList, new Set(['name', 'bytes', 'sha256']), `Ubuntu solver-input preparation list ${index}`);
    return Object.freeze({
      name: item.name,
      bytes: positiveInteger(item.bytes, `Ubuntu solver-input preparation list ${index} byte count`),
      sha256: exactString(item.sha256, SHA256, `Ubuntu solver-input preparation list ${index} SHA-256`),
    });
  });
  const expectedNames = expectedListNames(receipt.snapshot, receipt.codename, receipt.architecture);
  if (!sameValues(recordedLists.map((item) => item.name), expectedNames)
      || inventorySha256(recordedLists) !== listInventorySha256) {
    fail('Ubuntu solver-input preparation list evidence is inconsistent');
  }
  const requestedPackages = normalizeRequested(receipt.requestedPackages);
  if (!sameValues(requestedPackages, receipt.requestedPackages)) fail('Ubuntu solver-input preparation requested packages are not canonical');

  const solverRequest = exactObject(prepared.solverRequest, new Set([
    'workspace', 'configurationFile', 'statusFile', 'sourcesListFile', 'sourcePartsDirectory',
    'listsDirectory', 'snapshot', 'architecture', 'requestedPackages',
  ]), 'Ubuntu solver-input preparation solver request');
  const expectedPaths = Object.freeze({
    workspace: root,
    configurationFile: path.join(root, 'apt.conf'),
    statusFile: path.join(root, 'status'),
    sourcesListFile: path.join(root, 'sources.list'),
    sourcePartsDirectory: path.join(root, 'source-parts'),
    listsDirectory: path.join(root, 'lists'),
  });
  for (const [name, expected] of Object.entries(expectedPaths)) {
    if (absolutePath(solverRequest[name], `Ubuntu solver-input ${name}`) !== expected) fail('Ubuntu solver-input preparation solver paths are inconsistent');
  }
  if (solverRequest.snapshot !== receipt.snapshot || solverRequest.architecture !== receipt.architecture
      || !sameValues(solverRequest.requestedPackages, requestedPackages)) {
    fail('Ubuntu solver-input preparation solver authority is inconsistent');
  }
  const [receiptRecord, status, keyring, configuration, sources] = await Promise.all([
    readDirectFile(receiptFile, 'Ubuntu solver-input preparation receipt', MAX_CONFIGURATION_BYTES),
    readDirectFile(expectedPaths.statusFile, 'Ubuntu solver-input prepared status', MAX_STATUS_BYTES),
    readDirectFile(path.join(root, 'ubuntu-archive-keyring.gpg'), 'Ubuntu solver-input prepared keyring', MAX_KEYRING_BYTES),
    readDirectFile(expectedPaths.configurationFile, 'Ubuntu solver-input prepared configuration', MAX_CONFIGURATION_BYTES),
    readDirectFile(expectedPaths.sourcesListFile, 'Ubuntu solver-input prepared sources', MAX_CONFIGURATION_BYTES),
  ]);
  if (!receiptRecord.bytes.equals(Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8'))) fail('Ubuntu solver-input preparation receipt file does not match its value');
  if (status.bytes.byteLength !== statusBytes || status.sha256 !== statusSha256
      || ubuntuPackageStateSha256(parseUbuntuInstalledPackageState(status.bytes)) !== basePackageStateSha256
      || keyring.bytes.byteLength !== keyringBytes || keyring.sha256 !== keyringSha256
      || configuration.sha256 !== configurationSha256 || sources.sha256 !== sourcesSha256) {
    fail('Ubuntu solver-input preparation bound file changed after preparation');
  }
  if (!configuration.bytes.equals(Buffer.from(UBUNTU_APT_ISOLATED_CONFIGURATION, 'utf8'))
      || !sources.bytes.equals(Buffer.from(ubuntuSnapshotSources({
        codename: receipt.codename, architecture: receipt.architecture, keyring: keyring.location,
      }), 'utf8'))) {
    fail('Ubuntu solver-input preparation configuration or sources are inconsistent');
  }
  const [sourceParts, listsDirectory] = await Promise.all([
    directDirectory(expectedPaths.sourcePartsDirectory, root, 'Ubuntu solver-input prepared source-parts directory'),
    directDirectory(expectedPaths.listsDirectory, root, 'Ubuntu solver-input prepared lists directory'),
  ]);
  if ((await readdir(sourceParts.location)).length !== 0) fail('Ubuntu solver-input prepared source-parts directory changed after preparation');
  const currentLists = await observeListInventory(listsDirectory, expectedNames);
  if (inventorySha256(currentLists) !== listInventorySha256) fail('Ubuntu solver-input preparation list inventory changed after preparation');
  return Object.freeze({ ...solverRequest, requestedPackages });
}

function port(value, method, name) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') throw new TypeError(`${name} port is invalid`);
  return value;
}

export class UbuntuCapsuleSolverInputPreparer {
  constructor(raw = {}) {
    const value = exactObject(raw, new Set(['installer', 'snapshotLists']), 'Ubuntu solver-input preparer options');
    this.installer = port(value.installer, 'materialize', 'Ubuntu installer-layer materializer');
    this.snapshotLists = port(value.snapshotLists, 'prepare', 'Ubuntu snapshot-list preparer');
  }

  async prepare(raw = {}) {
    const request = exactObject(raw, new Set([
      'destination', 'media', 'mediaSha256', 'mediaBytes', 'distribution', 'release', 'codename',
      'architecture', 'snapshot', 'installSource', 'leafLayer', 'orderedLayers', 'requestedPackages', 'signal',
    ]), 'Ubuntu solver-input preparation request');
    const destination = absolutePath(request.destination, 'Ubuntu solver-input preparation destination');
    const media = absolutePath(request.media, 'Ubuntu installer media');
    const mediaSha256 = exactString(request.mediaSha256, SHA256, 'Ubuntu installer media SHA-256');
    const mediaBytes = positiveInteger(request.mediaBytes, 'Ubuntu installer media byte count');
    const distribution = exactString(request.distribution, TOKEN, 'Ubuntu distribution');
    const release = exactString(request.release, TOKEN, 'Ubuntu release');
    const codename = exactString(request.codename, TOKEN, 'Ubuntu codename');
    const architecture = exactString(request.architecture, ARCHITECTURE, 'Ubuntu architecture');
    const snapshot = exactString(request.snapshot, SNAPSHOT, 'Ubuntu snapshot');
    const installSource = normalizeUbuntuInstallationSource(request.installSource);
    const leafLayer = exactString(request.leafLayer, TOKEN, 'Ubuntu installer leaf layer');
    const orderedLayers = normalizeLayers(request.orderedLayers, leafLayer);
    const requestedPackages = normalizeRequested(request.requestedPackages);
    if (request.signal != null && typeof request.signal !== 'object') throw new TypeError('Ubuntu solver-input preparation signal is invalid');
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('Ubuntu solver-input preparation was interrupted');

    const mediaObservation = await hashDirectFile(media, 'Ubuntu installer media', mediaBytes);
    if (mediaObservation.bytes !== mediaBytes || mediaObservation.sha256 !== mediaSha256) {
      fail('Ubuntu installer media does not match its exact authority');
    }

    let owned = false;
    try {
      await mkdir(destination);
      owned = true;
      const installer = exactObject(await this.installer.materialize(Object.freeze({
        destination, media, mediaSha256, mediaBytes, installSource, leafLayer, orderedLayers,
        signal: request.signal ?? null,
      })), new Set(['statusFile', 'statusLayer', 'keyringFile', 'keyringLayer', 'layers', 'layerFiles']), 'Ubuntu installer materialization result');
      const layers = normalizeLayers(installer.layers, leafLayer);
      if (layers.length !== orderedLayers.length || layers.some((name, index) => name !== orderedLayers[index])) {
        fail('Ubuntu installer materialization returned different ordered layers');
      }
      if (!layers.includes(installer.statusLayer) || !layers.includes(installer.keyringLayer)) {
        fail('Ubuntu installer materialization returned an undeclared source layer');
      }
      const layerFiles = await observeLayers(installer.layerFiles, layers, destination, mediaBytes);
      const [status, keyring] = await Promise.all([
        readDirectFile(installer.statusFile, 'Ubuntu layered installer dpkg status', MAX_STATUS_BYTES),
        readDirectFile(installer.keyringFile, 'Ubuntu layered installer archive keyring', MAX_KEYRING_BYTES),
      ]);
      for (const selected of [status.location, keyring.location]) {
        const relative = path.relative(destination, selected);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('Ubuntu installer materialization escaped its preparation workspace');
      }
      const basePackages = parseUbuntuInstalledPackageState(status.bytes);
      const basePackageStateSha256 = ubuntuPackageStateSha256(basePackages);
      const expectedSources = ubuntuSnapshotSources({ codename, architecture, keyring: keyring.location });
      const prepared = exactObject(await this.snapshotLists.prepare(Object.freeze({
        destination, statusFile: status.location, keyringFile: keyring.location,
        sources: expectedSources, codename, architecture, snapshot, signal: request.signal ?? null,
      })), new Set([
        'configurationFile', 'sourcesListFile', 'sourcePartsDirectory', 'listsDirectory',
      ]), 'Ubuntu snapshot-list preparation result');
      const [configurationFile, sourcesListFile] = await Promise.all([
        readDirectFile(prepared.configurationFile, 'Ubuntu isolated APT configuration', MAX_CONFIGURATION_BYTES),
        readDirectFile(prepared.sourcesListFile, 'Ubuntu exact snapshot sources', MAX_CONFIGURATION_BYTES),
      ]);
      if (!configurationFile.bytes.equals(Buffer.from(UBUNTU_APT_ISOLATED_CONFIGURATION, 'utf8'))) {
        fail('Ubuntu snapshot-list preparation returned a non-isolated APT configuration');
      }
      if (!sourcesListFile.bytes.equals(Buffer.from(expectedSources, 'utf8'))) {
        fail('Ubuntu snapshot-list preparation returned different APT sources');
      }
      const [sourcePartsDirectory, listsDirectory] = await Promise.all([
        directDirectory(prepared.sourcePartsDirectory, destination, 'Ubuntu APT source-parts directory'),
        directDirectory(prepared.listsDirectory, destination, 'Ubuntu APT lists directory'),
      ]);
      if ((await readdir(sourcePartsDirectory.location)).length !== 0) fail('Ubuntu APT source-parts directory must be empty');
      const lists = await observeListInventory(listsDirectory, expectedListNames(snapshot, codename, architecture));
      if (request.signal?.aborted) throw request.signal.reason ?? new Error('Ubuntu solver-input preparation was interrupted');

      const solverRequest = Object.freeze({
        workspace: destination,
        configurationFile: configurationFile.location,
        statusFile: status.location,
        sourcesListFile: sourcesListFile.location,
        sourcePartsDirectory: sourcePartsDirectory.location,
        listsDirectory: listsDirectory.location,
        snapshot,
        architecture,
        requestedPackages,
      });
      const receipt = Object.freeze({
        protocol: UBUNTU_CAPSULE_SOLVER_INPUT_PREPARATION_PROTOCOL,
        distribution, release, codename, architecture, snapshot,
        media: Object.freeze({
          location: mediaObservation.location, bytes: mediaObservation.bytes, sha256: mediaSha256,
          observation: mediaObservation.observation,
        }),
        installer: Object.freeze({
          installSource, leafLayer, orderedLayers: layerFiles,
          statusLayer: installer.statusLayer, statusBytes: status.bytes.byteLength,
          statusSha256: status.sha256, basePackageStateSha256,
          keyringLayer: installer.keyringLayer, keyringBytes: keyring.bytes.byteLength,
          keyringSha256: keyring.sha256,
        }),
        apt: Object.freeze({
          configurationSha256: configurationFile.sha256,
          sourcesSha256: sourcesListFile.sha256,
          listInventorySha256: inventorySha256(lists),
          lists,
        }),
        requestedPackages,
      });
      const receiptFile = path.join(destination, 'preparation-receipt.json');
      await writeFile(receiptFile, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return Object.freeze({
        protocol: UBUNTU_CAPSULE_SOLVER_INPUT_PREPARATION_PROTOCOL,
        root: destination,
        receiptFile,
        receipt,
        solverRequest,
      });
    } catch (error) {
      if (owned) {
        const observed = await realpath(destination).catch(() => null);
        if (observed != null && await sameFilesystemIdentity(destination, observed)) {
          await rm(destination, { recursive: true, force: true });
        }
      }
      throw error;
    }
  }
}
