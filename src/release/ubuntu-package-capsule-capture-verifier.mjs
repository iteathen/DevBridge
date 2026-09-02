import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ubuntuPackageCapsuleReleasePayload } from '../setup/ubuntu-package-capsule-release-input.mjs';

const DIGEST = /^[a-f0-9]{64}$/u;
const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/u;
const MAX_SIGNED_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_DSC_BYTES = 4 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function exactRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Ubuntu capsule capture-verification request must be an object');
  for (const key of Object.keys(raw)) {
    if (!['release', 'readObject', 'verifyInRelease', 'decodeIndex'].includes(key)) {
      throw new TypeError(`Ubuntu capsule capture-verification request.${key} is unsupported`);
    }
  }
  return raw;
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
  if (headerEnd < 0) fail(`${name} clear-sign headers are invalid`);
  const signature = text.indexOf('\n-----BEGIN PGP SIGNATURE-----\n', headerEnd + 2);
  if (signature < 0) fail(`${name} clear-sign signature block is absent`);
  return text.slice(headerEnd + 2, signature + 1).split('\n').map((line) => (
    line.startsWith('- ') ? line.slice(2) : line
  )).join('\n');
}

function controlStanzas(text, name) {
  const stanzas = [];
  let current = Object.create(null);
  let selected = null;
  const finish = () => {
    if (Object.keys(current).length > 0) stanzas.push(current);
    current = Object.create(null);
    selected = null;
  };
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (line.length === 0) { finish(); continue; }
    if (/^[ \t]/u.test(line)) {
      if (selected == null) fail(`${name} has an orphan continuation line`);
      current[selected] += `\n${line.slice(1)}`;
      continue;
    }
    const match = /^([^: \t]+):[ \t]?(.*)$/u.exec(line);
    if (!match || Object.hasOwn(current, match[1])) fail(`${name} has an invalid or duplicate control field`);
    selected = match[1];
    current[selected] = match[2];
  }
  finish();
  if (stanzas.length < 1) fail(`${name} contains no control stanza`);
  return stanzas;
}

function checksumEntries(value, name) {
  if (typeof value !== 'string' || value.length < 1) fail(`${name} checksum field is absent`);
  const entries = new Map();
  for (const line of value.split('\n').filter((entry) => entry.trim().length > 0)) {
    const match = /^([a-f0-9]{64})[ \t]+([1-9][0-9]*)[ \t]+([^\s]+)$/u.exec(line.trim());
    if (!match) fail(`${name} checksum entry is invalid`);
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 1 || entries.has(match[3])) fail(`${name} checksum entry is invalid or duplicated`);
    entries.set(match[3], Object.freeze({ sha256: match[1], size }));
  }
  return entries;
}

function descriptorObjects(descriptor, name) {
  const objects = new Map(descriptor.objects.map((object) => [object.name, object]));
  if (objects.size !== descriptor.objects.length) fail(`${name} descriptor object names are duplicated`);
  return objects;
}

function requireDigestMatch(object, expected, name) {
  if (!object || object.size !== expected.size || object.sha256 !== expected.sha256) {
    fail(`${name} does not match its upstream size and SHA-256`);
  }
}

function decodeIndexDefault({ path: indexPath, bytes }) {
  if (indexPath.endsWith('.gz')) {
    let decoded;
    try { decoded = gunzipSync(bytes, { maxOutputLength: MAX_INDEX_BYTES }); }
    catch { fail(`Ubuntu capsule index ${indexPath} is not valid bounded gzip`); }
    return decoded;
  }
  if (indexPath.endsWith('.xz')) fail(`Ubuntu capsule index ${indexPath} requires an explicit xz decoder`);
  return bytes;
}

function exactField(stanza, field, name) {
  const value = stanza[field];
  if (typeof value !== 'string' || value.length < 1) fail(`${name} ${field} field is absent`);
  return value;
}

function words(stanza, field, context) {
  const selected = exactField(stanza, field, context).trim().split(/[ \t]+/u).filter(Boolean);
  if (selected.length < 1 || new Set(selected).size !== selected.length) fail(`${context} ${field} field is invalid`);
  return selected;
}

function decimalSize(value, name) {
  if (!/^[1-9][0-9]*$/u.test(value)) fail(`${name} size is invalid`);
  const size = Number(value);
  if (!Number.isSafeInteger(size)) fail(`${name} size exceeds the safe bound`);
  return size;
}

function sourceIdentity(stanza, binaryName, binaryVersion, name) {
  if (stanza.Source == null) return Object.freeze({ name: binaryName, version: binaryVersion });
  const match = /^([^ ()]+)(?: \(([^()]+)\))?$/u.exec(stanza.Source);
  if (!match) fail(`${name} Source field is invalid`);
  return Object.freeze({ name: match[1], version: match[2] ?? binaryVersion });
}

function addExactRecord(records, key, record, name) {
  const encoded = JSON.stringify(record);
  const previous = records.get(key);
  if (previous != null && previous.encoded !== encoded) fail(`${name} has conflicting signed index records`);
  records.set(key, Object.freeze({ encoded, record }));
}

function parseBinaryIndex(bytes, name, records) {
  for (const stanza of controlStanzas(utf8(bytes, name), name)) {
    const packageName = exactField(stanza, 'Package', name);
    const version = exactField(stanza, 'Version', name);
    const architecture = exactField(stanza, 'Architecture', name);
    const source = sourceIdentity(stanza, packageName, version, name);
    const record = Object.freeze({
      package: packageName,
      version,
      architecture,
      source: source.name,
      sourceVersion: source.version,
      filename: exactField(stanza, 'Filename', name),
      size: decimalSize(exactField(stanza, 'Size', name), name),
      sha256: exactField(stanza, 'SHA256', name).toLowerCase(),
    });
    if (!DIGEST.test(record.sha256)) fail(`${name} SHA256 field is invalid`);
    addExactRecord(records, `${record.package}\0${record.version}\0${record.architecture}`, record, name);
  }
}

function parseSourceIndex(bytes, name, records) {
  for (const stanza of controlStanzas(utf8(bytes, name), name)) {
    const record = Object.freeze({
      package: exactField(stanza, 'Package', name),
      version: exactField(stanza, 'Version', name),
      directory: exactField(stanza, 'Directory', name),
      files: checksumEntries(exactField(stanza, 'Checksums-Sha256', name), name),
    });
    const encoded = JSON.stringify({
      ...record,
      files: [...record.files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    });
    const key = `${record.package}\0${record.version}`;
    const previous = records.get(key);
    if (previous != null && previous.encoded !== encoded) fail(`${name} has conflicting signed source records`);
    records.set(key, Object.freeze({ encoded, record }));
  }
}

function verifyDsc(bytes, source, sourceObjects, name) {
  const text = utf8(bytes, name);
  const payload = text.startsWith('-----BEGIN PGP SIGNED MESSAGE-----') ? clearSignedPayload(bytes, name) : text;
  const stanzas = controlStanzas(payload, name);
  if (stanzas.length !== 1) fail(`${name} must contain one source control stanza`);
  const stanza = stanzas[0];
  if (exactField(stanza, 'Source', name) !== source.package || exactField(stanza, 'Version', name) !== source.version) {
    fail(`${name} source identity does not match the capsule inventory`);
  }
  const checksums = checksumEntries(exactField(stanza, 'Checksums-Sha256', name), name);
  const expectedNames = new Set(source.files.map((file) => file.filename));
  if (checksums.size !== expectedNames.size || [...checksums].some(([filename]) => !expectedNames.has(filename))) {
    fail(`${name} does not exactly cover the capsule source files`);
  }
  for (const file of source.files) requireDigestMatch(sourceObjects.get(file.object), checksums.get(file.filename), `${name} file ${file.filename}`);
}

export async function verifyUbuntuPackageCapsuleCapture(raw = {}) {
  const {
    release,
    readObject,
    verifyInRelease,
    decodeIndex = decodeIndexDefault,
  } = exactRequest(raw);
  ubuntuPackageCapsuleReleasePayload(release);
  if (typeof readObject !== 'function') throw new TypeError('Ubuntu capsule object-reader port is invalid');
  if (typeof verifyInRelease !== 'function') throw new TypeError('Ubuntu capsule InRelease-verifier port is invalid');
  if (typeof decodeIndex !== 'function') throw new TypeError('Ubuntu capsule index-decoder port is invalid');
  const metadataObjects = descriptorObjects(release.metadata.descriptor, 'Ubuntu capsule metadata');
  const binaryObjects = descriptorObjects(release.binaries.descriptor, 'Ubuntu capsule binary');
  const sourceObjects = descriptorObjects(release.sources.descriptor, 'Ubuntu capsule source');
  const binaryRecords = new Map();
  const sourceRecords = new Map();
  const pockets = [];

  for (const pocket of release.metadata.pockets) {
    const inReleaseBytes = exactBytes(
      await readObject('metadata', pocket.inRelease.object, MAX_SIGNED_METADATA_BYTES),
      `Ubuntu capsule ${pocket.pocket} InRelease`,
      MAX_SIGNED_METADATA_BYTES,
    );
    const inReleaseObject = metadataObjects.get(pocket.inRelease.object);
    requireDigestMatch(inReleaseObject, { size: inReleaseBytes.length, sha256: sha256(inReleaseBytes) }, `Ubuntu capsule ${pocket.pocket} InRelease`);
    const signature = await verifyInRelease({
      bytes: inReleaseBytes,
      expectedFingerprint: release.upstreamKeyFingerprint,
      context: pocket.pocket,
    });
    if (!signature || signature.verified !== true || signature.fingerprint !== release.upstreamKeyFingerprint
        || Object.keys(signature).some((key) => !['verified', 'fingerprint'].includes(key))) {
      fail(`Ubuntu capsule ${pocket.pocket} InRelease signature evidence is invalid`);
    }
    const releaseFields = controlStanzas(clearSignedPayload(inReleaseBytes, `Ubuntu capsule ${pocket.pocket} InRelease`), `Ubuntu capsule ${pocket.pocket} InRelease`);
    if (releaseFields.length !== 1) fail(`Ubuntu capsule ${pocket.pocket} InRelease payload is invalid`);
    const releaseStanza = releaseFields[0];
    const releaseContext = `Ubuntu capsule ${pocket.pocket} InRelease`;
    if (exactField(releaseStanza, 'Suite', releaseContext) !== pocket.pocket
        || exactField(releaseStanza, 'Codename', releaseContext) !== release.codename) {
      fail(`${releaseContext} release identity does not match the capsule subject`);
    }
    const architectures = words(releaseStanza, 'Architectures', releaseContext);
    const components = words(releaseStanza, 'Components', releaseContext);
    if (!architectures.includes(release.architecture)
        || !['main', 'universe'].every((component) => components.includes(component))) {
      fail(`${releaseContext} architecture or component set does not cover the capsule subject`);
    }
    const indexChecksums = checksumEntries(exactField(releaseStanza, 'SHA256', releaseContext), releaseContext);
    for (const component of pocket.components) {
      for (const [kind, index] of [['binary', component.binaryIndex], ['source', component.sourceIndex]]) {
        const expected = indexChecksums.get(index.path);
        if (!expected) fail(`Ubuntu capsule ${pocket.pocket}/${component.component} ${kind} index is absent from InRelease`);
        const descriptorObject = metadataObjects.get(index.object);
        requireDigestMatch(descriptorObject, expected, `Ubuntu capsule ${pocket.pocket}/${component.component} ${kind} index`);
        const compressed = exactBytes(
          await readObject('metadata', index.object, MAX_INDEX_BYTES),
          `Ubuntu capsule ${pocket.pocket}/${component.component} ${kind} index`,
          MAX_INDEX_BYTES,
        );
        requireDigestMatch(descriptorObject, { size: compressed.length, sha256: sha256(compressed) }, `Ubuntu capsule ${pocket.pocket}/${component.component} ${kind} index bytes`);
        const decoded = exactBytes(
          await decodeIndex({ path: index.path, bytes: compressed }),
          `Ubuntu capsule ${pocket.pocket}/${component.component} decoded ${kind} index`,
          MAX_INDEX_BYTES,
        );
        if (kind === 'binary') parseBinaryIndex(decoded, `Ubuntu capsule ${pocket.pocket}/${component.component} Packages`, binaryRecords);
        else parseSourceIndex(decoded, `Ubuntu capsule ${pocket.pocket}/${component.component} Sources`, sourceRecords);
      }
    }
    pockets.push(Object.freeze({ pocket: pocket.pocket, fingerprint: signature.fingerprint }));
  }

  for (const binary of release.binaries.packages) {
    const indexed = binaryRecords.get(`${binary.package}\0${binary.version}\0${binary.architecture}`)?.record;
    if (!indexed || indexed.package !== binary.package || indexed.version !== binary.version
        || indexed.architecture !== binary.architecture || indexed.source !== binary.source
        || indexed.sourceVersion !== binary.sourceVersion || indexed.filename !== binary.filename) {
      fail(`Ubuntu capsule binary ${binary.package} does not match a signed Packages record`);
    }
    requireDigestMatch(binaryObjects.get(binary.object), indexed, `Ubuntu capsule binary ${binary.package}`);
  }

  for (const source of release.sources.packages) {
    const indexed = sourceRecords.get(`${source.package}\0${source.version}`)?.record;
    if (!indexed || indexed.directory !== source.directory) {
      fail(`Ubuntu capsule source ${source.package} does not match a signed Sources record`);
    }
    const inventoryFiles = [source.dsc, ...source.files];
    const expectedNames = new Set(inventoryFiles.map((file) => file.filename));
    if (indexed.files.size !== expectedNames.size || [...indexed.files].some(([filename]) => !expectedNames.has(filename))) {
      fail(`Ubuntu capsule source ${source.package} does not exactly cover its signed Sources files`);
    }
    for (const file of inventoryFiles) {
      requireDigestMatch(sourceObjects.get(file.object), indexed.files.get(file.filename), `Ubuntu capsule source ${source.package}/${file.filename}`);
    }
    const dscBytes = exactBytes(
      await readObject('source', source.dsc.object, MAX_DSC_BYTES),
      `Ubuntu capsule source ${source.package} dsc`,
      MAX_DSC_BYTES,
    );
    requireDigestMatch(sourceObjects.get(source.dsc.object), { size: dscBytes.length, sha256: sha256(dscBytes) }, `Ubuntu capsule source ${source.package} dsc bytes`);
    verifyDsc(dscBytes, source, sourceObjects, `Ubuntu capsule source ${source.package} dsc`);
  }

  return Object.freeze({
    verified: true,
    upstreamKeyFingerprint: release.upstreamKeyFingerprint,
    pockets: Object.freeze(pockets),
    binaryPackages: release.binaries.packages.length,
    sourcePackages: release.sources.packages.length,
  });
}
