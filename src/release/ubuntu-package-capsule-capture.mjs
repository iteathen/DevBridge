import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { normalizeUbuntuAptTransactionSolution } from './ubuntu-apt-transaction-solver.mjs';

export const UBUNTU_PACKAGE_CAPSULE_CAPTURE_PROTOCOL = 'devbridge/ubuntu-package-capsule-capture-v1';

const DIGEST = /^[a-f0-9]{64}$/u;
const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/u;
const RELEASE = /^[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?$/u;
const CODENAME = /^[a-z][a-z0-9-]{0,31}$/u;
const ARCHITECTURE = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,95}$/u;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,99}$/u;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,199}$/u;
const COMPONENTS = Object.freeze(['main', 'universe']);
const MAX_INRELEASE_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function exactText(value, expression, name) {
  if (typeof value !== 'string' || !expression.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function archivePath(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.startsWith('/') || value.endsWith('/')
      || value.includes('\\') || value.includes('//') || /[?#\u0000-\u001f\u007f]/u.test(value)
      || !/^[A-Za-z0-9._+%~/-]+$/u.test(value)) throw new TypeError(`${name} is invalid`);
  for (const segment of value.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new TypeError(`${name} is invalid`); }
    if (!segment || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new TypeError(`${name} is invalid`);
    }
  }
  return value;
}

function archiveLeaf(value, name) {
  const normalized = archivePath(value, name);
  if (normalized.includes('/')) throw new TypeError(`${name} must be a filename`);
  return normalized;
}

function exactBytes(value, name, maximum) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    throw new TypeError(`${name} bytes are invalid`);
  }
  return Buffer.from(value);
}

function utf8(bytes, name) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(`${name} is not valid UTF-8`); }
}

function clearSignedPayload(bytes, name) {
  const text = utf8(bytes, name).replaceAll('\r\n', '\n');
  const marker = '-----BEGIN PGP SIGNED MESSAGE-----\n';
  if (!text.startsWith(marker)) fail(`${name} is not a clear-signed document`);
  const headerEnd = text.indexOf('\n\n', marker.length);
  const signature = text.indexOf('\n-----BEGIN PGP SIGNATURE-----\n', headerEnd + 2);
  if (headerEnd < 0 || signature < 0) fail(`${name} clear-sign envelope is invalid`);
  return text.slice(headerEnd + 2, signature + 1).split('\n').map((line) => (
    line.startsWith('- ') ? line.slice(2) : line
  )).join('\n');
}

function controlStanzas(text, name) {
  const result = [];
  let current = Object.create(null);
  let selected = null;
  const finish = () => {
    if (Object.keys(current).length > 0) result.push(current);
    current = Object.create(null);
    selected = null;
  };
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (line === '') { finish(); continue; }
    if (/^[ \t]/u.test(line)) {
      if (selected == null) fail(`${name} has an orphan continuation`);
      current[selected] += `\n${line.slice(1)}`;
      continue;
    }
    const match = /^([^: \t]+):[ \t]?(.*)$/u.exec(line);
    if (!match || Object.hasOwn(current, match[1])) fail(`${name} has an invalid control field`);
    selected = match[1];
    current[selected] = match[2];
  }
  finish();
  if (result.length < 1) fail(`${name} contains no control stanza`);
  return result;
}

function field(stanza, selected, name) {
  const value = stanza[selected];
  if (typeof value !== 'string' || value.length < 1) fail(`${name} ${selected} field is absent`);
  return value;
}

function checksums(value, name, { leaf = false } = {}) {
  const result = new Map();
  for (const line of String(value ?? '').split('\n').filter((entry) => entry.trim())) {
    const match = /^([a-f0-9]{64})[ \t]+([1-9][0-9]*)[ \t]+([^\s]+)$/u.exec(line.trim());
    const size = match ? Number(match[2]) : Number.NaN;
    if (!match || !Number.isSafeInteger(size) || size < 1) fail(`${name} checksum is invalid`);
    const filename = leaf
      ? archiveLeaf(match[3], `${name} filename`)
      : archivePath(match[3], `${name} path`);
    if (result.has(filename)) fail(`${name} checksum is invalid`);
    result.set(filename, Object.freeze({ sha256: match[1], size }));
  }
  if (result.size < 1) fail(`${name} checksum set is empty`);
  return result;
}

function sourceIdentity(stanza, packageName, version, name) {
  if (stanza.Source == null) return Object.freeze({ package: packageName, version });
  const match = /^([^ ()]+)(?: \(([^()]+)\))?$/u.exec(stanza.Source);
  if (!match) fail(`${name} Source field is invalid`);
  return Object.freeze({ package: match[1], version: match[2] ?? version });
}

function parseBinaryIndex(bytes, name, records) {
  for (const stanza of controlStanzas(utf8(bytes, name), name)) {
    const packageName = exactText(field(stanza, 'Package', name), PACKAGE_NAME, `${name} Package`);
    const version = exactText(field(stanza, 'Version', name), PACKAGE_VERSION, `${name} Version`);
    const architecture = exactText(field(stanza, 'Architecture', name), ARCHITECTURE, `${name} Architecture`);
    const source = sourceIdentity(stanza, packageName, version, name);
    const filename = archivePath(field(stanza, 'Filename', name), `${name} Filename`);
    if (!filename.endsWith('.deb')) fail(`${name} Filename does not identify a .deb`);
    const size = Number(field(stanza, 'Size', name));
    const digest = field(stanza, 'SHA256', name).toLowerCase();
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ARTIFACT_BYTES || !DIGEST.test(digest)) fail(`${name} binary identity is invalid`);
    const record = Object.freeze({
      package: packageName, version, architecture,
      source: exactText(source.package, PACKAGE_NAME, `${name} source package`),
      sourceVersion: exactText(source.version, PACKAGE_VERSION, `${name} source version`),
      filename, size, sha256: digest,
    });
    const key = `${packageName}\0${version}\0${architecture}`;
    const prior = records.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(record)) fail(`${name} conflicts with another signed binary record`);
    records.set(key, record);
  }
}

function parseSourceIndex(bytes, name, records) {
  for (const stanza of controlStanzas(utf8(bytes, name), name)) {
    const packageName = exactText(field(stanza, 'Package', name), PACKAGE_NAME, `${name} Package`);
    const version = exactText(field(stanza, 'Version', name), PACKAGE_VERSION, `${name} Version`);
    const directory = archivePath(field(stanza, 'Directory', name), `${name} Directory`);
    const files = checksums(field(stanza, 'Checksums-Sha256', name), `${name} Checksums-Sha256`, { leaf: true });
    const record = Object.freeze({ package: packageName, version, directory, files });
    const key = `${packageName}\0${version}`;
    const encoded = JSON.stringify({ package: packageName, version, directory, files: [...files] });
    const prior = records.get(key);
    if (prior && prior.encoded !== encoded) fail(`${name} conflicts with another signed source record`);
    records.set(key, Object.freeze({ encoded, record }));
  }
}

function decodeIndex(bytes, selectedPath) {
  if (!selectedPath.endsWith('.gz')) fail(`Ubuntu snapshot index ${selectedPath} is not the fixed gzip representation`);
  try { return gunzipSync(bytes, { maxOutputLength: MAX_INDEX_BYTES }); }
  catch { fail(`Ubuntu snapshot index ${selectedPath} is not valid bounded gzip`); }
}

function policy(raw, solution) {
  const value = exactObject(raw, new Set([
    'distribution', 'release', 'codename', 'architecture', 'snapshot', 'baseMediaSha256',
    'releaseId', 'sequence', 'upstreamKeyFingerprint',
  ]), 'Ubuntu capsule capture policy');
  if (value.distribution !== 'ubuntu') fail('Ubuntu capsule capture distribution is unsupported');
  const normalized = Object.freeze({
    distribution: value.distribution,
    release: exactText(value.release, RELEASE, 'Ubuntu capsule capture release'),
    codename: exactText(value.codename, CODENAME, 'Ubuntu capsule capture codename'),
    architecture: exactText(value.architecture, ARCHITECTURE, 'Ubuntu capsule capture architecture'),
    snapshot: exactText(value.snapshot, /^\d{8}T\d{6}Z$/u, 'Ubuntu capsule capture snapshot'),
    baseMediaSha256: exactText(value.baseMediaSha256, DIGEST, 'Ubuntu capsule capture base-media digest'),
    releaseId: exactText(value.releaseId, SAFE_ID, 'Ubuntu capsule capture release identity'),
    sequence: value.sequence,
    upstreamKeyFingerprint: exactText(value.upstreamKeyFingerprint, FINGERPRINT, 'Ubuntu capsule capture upstream key fingerprint'),
  });
  if (!Number.isSafeInteger(normalized.sequence) || normalized.sequence < 1) throw new TypeError('Ubuntu capsule capture sequence is invalid');
  if (solution.snapshot !== normalized.snapshot || solution.architecture !== normalized.architecture) {
    fail('Ubuntu capsule capture policy does not match the solved transaction');
  }
  return normalized;
}

async function readExact(readArchive, request, maximum) {
  const boundedRequest = Object.freeze({ ...request, maximum });
  const bytes = exactBytes(await readArchive(boundedRequest), `Ubuntu archive ${request.path}`, maximum);
  if (request.size != null && (bytes.length !== request.size || sha256(bytes) !== request.sha256)) {
    fail(`Ubuntu archive ${request.path} does not match signed size and SHA-256`);
  }
  return bytes;
}

async function writeAll(handle, bytes) {
  let position = 0;
  while (position < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, position, bytes.length - position, position);
    if (bytesWritten < 1) fail('Ubuntu capsule capture write did not advance');
    position += bytesWritten;
  }
}

async function writeArtifact(root, ordinal, bytes) {
  const location = path.join(root, `artifact-${String(ordinal).padStart(5, '0')}`);
  const handle = await open(location, 'wx', 0o600);
  try { await writeAll(handle, bytes); await handle.sync(); }
  finally { await handle.close(); }
  return location;
}

export async function captureUbuntuPackageCapsule(raw = {}) {
  const request = exactObject(raw, new Set([
    'policy', 'solution', 'destination', 'readArchive', 'verifyInRelease', 'signal',
  ]), 'Ubuntu package-capsule capture request');
  const solution = normalizeUbuntuAptTransactionSolution(request.solution);
  const selectedPolicy = policy(request.policy, solution);
  if (typeof request.destination !== 'string' || !path.isAbsolute(request.destination) || request.destination.includes('\0')) {
    throw new TypeError('Ubuntu capsule capture destination is invalid');
  }
  if (typeof request.readArchive !== 'function') throw new TypeError('Ubuntu capsule archive-reader port is invalid');
  if (typeof request.verifyInRelease !== 'function') throw new TypeError('Ubuntu capsule signature-verifier port is invalid');
  if (request.signal != null && typeof request.signal !== 'object') throw new TypeError('Ubuntu capsule capture signal is invalid');
  if (request.signal?.aborted) throw request.signal.reason ?? new Error('Ubuntu capsule capture was interrupted');
  const root = path.resolve(request.destination);
  try { await mkdir(root, { recursive: false, mode: 0o700 }); }
  catch (error) { if (error?.code === 'EEXIST') fail('Ubuntu capsule capture destination already exists'); throw error; }
  const artifacts = { metadata: [], binary: [], source: [] };
  let ordinal = 0;
  let totalBytes = 0;
  const recordArtifact = async (group, name, bytes) => {
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) fail('Ubuntu capsule capture exceeds its total byte bound');
    const location = await writeArtifact(root, ordinal, bytes);
    ordinal += 1;
    artifacts[group].push(Object.freeze({ name, location }));
  };
  try {
    const binaryRecords = new Map();
    const sourceRecords = new Map();
    const pockets = [];
    for (const pocket of [selectedPolicy.codename, `${selectedPolicy.codename}-updates`, `${selectedPolicy.codename}-security`]) {
      const inReleasePath = `dists/${pocket}/InRelease`;
      const inReleaseBytes = await readExact(request.readArchive, { path: inReleasePath, signal: request.signal }, MAX_INRELEASE_BYTES);
      const signature = await request.verifyInRelease(Object.freeze({
        bytes: inReleaseBytes,
        expectedFingerprint: selectedPolicy.upstreamKeyFingerprint,
        context: pocket,
        signal: request.signal,
      }));
      if (!signature || signature.verified !== true || signature.fingerprint !== selectedPolicy.upstreamKeyFingerprint
          || Object.keys(signature).some((key) => !['verified', 'fingerprint'].includes(key))) {
        fail(`Ubuntu snapshot ${pocket} signature evidence is invalid`);
      }
      const stanzas = controlStanzas(clearSignedPayload(inReleaseBytes, `Ubuntu snapshot ${pocket} InRelease`), `Ubuntu snapshot ${pocket} InRelease`);
      if (stanzas.length !== 1) fail(`Ubuntu snapshot ${pocket} InRelease payload is invalid`);
      const stanza = stanzas[0];
      if (field(stanza, 'Suite', pocket) !== pocket || field(stanza, 'Codename', pocket) !== selectedPolicy.codename) {
        fail(`Ubuntu snapshot ${pocket} release identity changed`);
      }
      const architectures = field(stanza, 'Architectures', pocket).split(/[ \t]+/u);
      const components = field(stanza, 'Components', pocket).split(/[ \t]+/u);
      if (!architectures.includes(selectedPolicy.architecture) || !COMPONENTS.every((entry) => components.includes(entry))) {
        fail(`Ubuntu snapshot ${pocket} topology does not cover the capture policy`);
      }
      const signedIndexes = checksums(field(stanza, 'SHA256', pocket), `Ubuntu snapshot ${pocket} InRelease`);
      const captureComponents = [];
      await recordArtifact('metadata', `${pocket}-inrelease`, inReleaseBytes);
      for (const component of COMPONENTS) {
        const binaryPath = `${component}/binary-${selectedPolicy.architecture}/Packages.gz`;
        const sourcePath = `${component}/source/Sources.gz`;
        const binaryExpected = signedIndexes.get(binaryPath);
        const sourceExpected = signedIndexes.get(sourcePath);
        if (!binaryExpected || !sourceExpected) fail(`Ubuntu snapshot ${pocket}/${component} fixed gzip indexes are absent`);
        const binaryBytes = await readExact(request.readArchive, {
          path: `dists/${pocket}/${binaryPath}`, ...binaryExpected, signal: request.signal,
        }, MAX_INDEX_BYTES);
        const sourceBytes = await readExact(request.readArchive, {
          path: `dists/${pocket}/${sourcePath}`, ...sourceExpected, signal: request.signal,
        }, MAX_INDEX_BYTES);
        const binaryName = `${pocket}-${component}-binary-index`;
        const sourceName = `${pocket}-${component}-source-index`;
        await recordArtifact('metadata', binaryName, binaryBytes);
        await recordArtifact('metadata', sourceName, sourceBytes);
        parseBinaryIndex(decodeIndex(binaryBytes, binaryPath), `Ubuntu snapshot ${pocket}/${component} Packages`, binaryRecords);
        parseSourceIndex(decodeIndex(sourceBytes, sourcePath), `Ubuntu snapshot ${pocket}/${component} Sources`, sourceRecords);
        captureComponents.push(Object.freeze({
          component,
          binaryIndex: Object.freeze({ path: binaryPath, object: binaryName }),
          sourceIndex: Object.freeze({ path: sourcePath, object: sourceName }),
        }));
      }
      pockets.push(Object.freeze({
        pocket,
        inRelease: Object.freeze({ path: inReleasePath, object: `${pocket}-inrelease` }),
        components: Object.freeze(captureComponents),
      }));
    }

    const binaries = [];
    const sourceIdentities = new Map();
    for (const [index, selected] of solution.selectedPackages.entries()) {
      const record = binaryRecords.get(`${selected.package}\0${selected.version}\0${selected.architecture}`);
      if (!record) fail(`Ubuntu solved binary ${selected.package}:${selected.architecture} is absent from signed indexes`);
      const bytes = await readExact(request.readArchive, {
        path: record.filename, size: record.size, sha256: record.sha256, signal: request.signal,
      }, MAX_ARTIFACT_BYTES);
      const object = `binary-${String(index).padStart(5, '0')}`;
      await recordArtifact('binary', object, bytes);
      binaries.push(Object.freeze({
        package: record.package, version: record.version, architecture: record.architecture,
        source: record.source, sourceVersion: record.sourceVersion, filename: record.filename, object,
      }));
      sourceIdentities.set(`${record.source}\0${record.sourceVersion}`, Object.freeze({ package: record.source, version: record.sourceVersion }));
    }

    const sources = [];
    let sourceArtifact = 0;
    for (const identity of [...sourceIdentities.values()].sort((left, right) => compareText(left.package, right.package) || compareText(left.version, right.version))) {
      const source = sourceRecords.get(`${identity.package}\0${identity.version}`)?.record;
      if (!source) fail(`Ubuntu binary source ${identity.package} ${identity.version} is absent from signed indexes`);
      const entries = [...source.files].sort(([left], [right]) => compareText(left, right));
      const dscEntries = entries.filter(([filename]) => filename.endsWith('.dsc'));
      if (dscEntries.length !== 1 || entries.length < 2) fail(`Ubuntu source ${identity.package} has an invalid signed file inventory`);
      const captured = [];
      for (const [filename, expected] of entries) {
        const bytes = await readExact(request.readArchive, {
          path: `${source.directory}/${filename}`, ...expected, signal: request.signal,
        }, MAX_ARTIFACT_BYTES);
        const object = `source-${String(sourceArtifact).padStart(5, '0')}`;
        sourceArtifact += 1;
        await recordArtifact('source', object, bytes);
        captured.push(Object.freeze({ filename, object }));
      }
      const dsc = captured.find((entry) => entry.filename.endsWith('.dsc'));
      sources.push(Object.freeze({
        package: source.package,
        version: source.version,
        directory: source.directory,
        dsc,
        files: Object.freeze(captured.filter((entry) => entry !== dsc)),
      }));
    }
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('Ubuntu capsule capture was interrupted');
    return Object.freeze({
      protocol: UBUNTU_PACKAGE_CAPSULE_CAPTURE_PROTOCOL,
      root,
      capture: Object.freeze({
        ...selectedPolicy,
        transaction: solution.transaction,
        metadata: Object.freeze({ pockets: Object.freeze(pockets) }),
        binaries: Object.freeze({ packages: Object.freeze(binaries) }),
        sources: Object.freeze({ packages: Object.freeze(sources) }),
      }),
      artifacts: Object.freeze({
        metadata: Object.freeze(artifacts.metadata),
        binary: Object.freeze(artifacts.binary),
        source: Object.freeze(artifacts.source),
      }),
      artifactCount: ordinal,
      bytes: totalBytes,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
