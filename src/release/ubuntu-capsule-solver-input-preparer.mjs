import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
    const installSource = exactString(request.installSource, TOKEN, 'Ubuntu install source');
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
