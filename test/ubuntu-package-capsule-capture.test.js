import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  UBUNTU_APT_TRANSACTION_SOLUTION_PROTOCOL,
} from '../src/release/ubuntu-apt-transaction-solver.mjs';
import {
  captureUbuntuPackageCapsule,
  UBUNTU_PACKAGE_CAPSULE_CAPTURE_PROTOCOL,
} from '../src/release/ubuntu-package-capsule-capture.mjs';
import { buildUbuntuPackageCapsuleRelease } from '../src/release/ubuntu-package-capsule-release-builder.mjs';
import { verifyUbuntuPackageCapsuleReleaseInput } from '../src/setup/ubuntu-package-capsule-release-input.mjs';
import { createUbuntuPackageCaptureFixture } from './fixtures/ubuntu-package-capsule-capture-fixture.js';

function solution(capture) {
  const selectedPackages = capture.binaries.packages.map((entry) => ({
    package: entry.package, version: entry.version, architecture: entry.architecture,
  }));
  return {
    protocol: UBUNTU_APT_TRANSACTION_SOLUTION_PROTOCOL,
    snapshot: capture.snapshot,
    architecture: capture.architecture,
    basePackages: [{ package: 'libc6', version: '2.40-1ubuntu1', architecture: 'amd64' }],
    resultPackages: selectedPackages,
    selectedPackages,
    requestedPackages: selectedPackages.filter((entry) => ['build-essential', 'cmake'].includes(entry.package)),
  };
}

function policy(capture) {
  return Object.fromEntries([
    'distribution', 'release', 'codename', 'architecture', 'snapshot', 'baseMediaSha256',
    'releaseId', 'sequence', 'upstreamKeyFingerprint',
  ].map((key) => [key, capture[key]]));
}

async function input() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'devbridge-capsule-capture-input-'));
  const fixture = await createUbuntuPackageCaptureFixture(path.join(fixtureRoot, 'fixture'));
  const byObject = new Map(fixture.artifacts.metadata.concat(fixture.artifacts.binary, fixture.artifacts.source)
    .map((entry) => [entry.name, entry.location]));
  const archive = new Map();
  for (const pocket of fixture.capture.metadata.pockets) {
    archive.set(pocket.inRelease.path, await readFile(byObject.get(pocket.inRelease.object)));
    for (const component of pocket.components) {
      archive.set(`dists/${pocket.pocket}/${component.binaryIndex.path}`, await readFile(byObject.get(component.binaryIndex.object)));
      archive.set(`dists/${pocket.pocket}/${component.sourceIndex.path}`, await readFile(byObject.get(component.sourceIndex.object)));
    }
  }
  for (const binary of fixture.capture.binaries.packages) archive.set(binary.filename, await readFile(byObject.get(binary.object)));
  for (const source of fixture.capture.sources.packages) {
    for (const entry of [source.dsc, ...source.files]) archive.set(`${source.directory}/${entry.filename}`, await readFile(byObject.get(entry.object)));
  }
  return { fixtureRoot, fixture, archive };
}

function reader(archive, mutate = null) {
  return async (request) => {
    const bytes = archive.get(request.path);
    if (!bytes) throw new Error(`fixture archive path is absent: ${request.path}`);
    return mutate?.(request, bytes) ?? bytes;
  };
}

function verifier(fingerprint) {
  return async ({ expectedFingerprint }) => ({ verified: true, fingerprint: expectedFingerprint === fingerprint ? fingerprint : '' });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function binarySemantics(entry) {
  const { object: _object, ...value } = entry;
  return value;
}

function sourceSemantics(entry) {
  return {
    package: entry.package,
    version: entry.version,
    directory: entry.directory,
    dsc: { filename: entry.dsc.filename },
    files: entry.files.map((file) => ({ filename: file.filename })).sort((left, right) => left.filename.localeCompare(right.filename)),
  };
}

test('capture maps one solved transaction through signed metadata to exact binary and source artifacts', async () => {
  const { fixtureRoot, fixture, archive } = await input();
  const destination = path.join(fixtureRoot, 'capture');
  try {
    const result = await captureUbuntuPackageCapsule({
      policy: policy(fixture.capture),
      solution: solution(fixture.capture),
      destination,
      readArchive: reader(archive),
      verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
    });
    assert.equal(result.protocol, UBUNTU_PACKAGE_CAPSULE_CAPTURE_PROTOCOL);
    assert.deepEqual(result.capture.binaries.packages.map(binarySemantics), fixture.capture.binaries.packages.map(binarySemantics));
    assert.deepEqual(result.capture.sources.packages.map(sourceSemantics), fixture.capture.sources.packages.map(sourceSemantics));
    assert.deepEqual(result.capture.metadata.pockets, fixture.capture.metadata.pockets);
    assert.equal(result.capture.transaction.requestedPackages.length, 2);
    assert.equal(result.artifactCount, 15 + 3 + 8);
    assert.ok(result.bytes > 0);
    for (const group of ['metadata', 'binary', 'source']) {
      assert.ok(result.artifacts[group].every((entry) => path.dirname(entry.location) === destination));
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyBytes = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const publicKeyBytes = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }));
    const sealed = await buildUbuntuPackageCapsuleRelease({
      capture: result.capture,
      artifacts: result.artifacts,
      destination: path.join(fixtureRoot, 'release'),
      keyId: 'capture-composition-test',
      privateKeyBytes,
      publicKeyBytes,
      verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
    });
    const verified = verifyUbuntuPackageCapsuleReleaseInput({
      manifestBytes: await readFile(path.join(sealed.root, sealed.manifestName)),
      publicKeyBytes: await readFile(path.join(sealed.root, sealed.publicKeyName)),
      expectedManifestSha256: sealed.manifestSha256,
      expectedPublicKeySha256: sealed.publicKeySha256,
      expectedKeyId: sealed.keyId,
    });
    assert.equal(verified.releaseId, fixture.capture.releaseId);
    assert.equal(verified.binaries.packages.length, 3);
    assert.equal(verified.sources.packages.length, 3);
  } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
});

test('capture rejects changed signed index bytes and removes its owned partial destination', async () => {
  const { fixtureRoot, fixture, archive } = await input();
  const destination = path.join(fixtureRoot, 'capture');
  try {
    await assert.rejects(captureUbuntuPackageCapsule({
      policy: policy(fixture.capture),
      solution: solution(fixture.capture),
      destination,
      readArchive: reader(archive, (request, bytes) => request.path.endsWith('/main/binary-amd64/Packages.gz')
        ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes),
      verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
    }), /does not match signed size and SHA-256/u);
    await assert.rejects(readFile(destination), /ENOENT/u);
  } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
});

test('capture rejects signature substitution before binary or source acquisition', async () => {
  const { fixtureRoot, fixture, archive } = await input();
  const requested = [];
  try {
    await assert.rejects(captureUbuntuPackageCapsule({
      policy: policy(fixture.capture),
      solution: solution(fixture.capture),
      destination: path.join(fixtureRoot, 'capture'),
      readArchive: async (request) => { requested.push(request.path); return reader(archive)(request); },
      verifyInRelease: async () => ({ verified: true, fingerprint: 'F'.repeat(40) }),
    }), /signature evidence is invalid/u);
    assert.deepEqual(requested, ['dists/resolute/InRelease']);
  } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
});

test('capture rejects a solved package absent from signed indexes', async () => {
  const { fixtureRoot, fixture, archive } = await input();
  const selected = solution(fixture.capture);
  selected.selectedPackages[0] = { ...selected.selectedPackages[0], version: '99.0' };
  selected.resultPackages[0] = { ...selected.resultPackages[0], version: '99.0' };
  selected.requestedPackages[0] = { ...selected.requestedPackages[0], version: '99.0' };
  try {
    await assert.rejects(captureUbuntuPackageCapsule({
      policy: policy(fixture.capture), solution: selected,
      destination: path.join(fixtureRoot, 'capture'),
      readArchive: reader(archive), verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
    }), /is absent from signed indexes/u);
  } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
});

test('capture rejects a signed source filename that is not an archive leaf before artifact acquisition', async () => {
  const { fixtureRoot, fixture, archive } = await input();
  const pocket = fixture.capture.metadata.pockets[0];
  const component = pocket.components[0];
  const sourceIndexPath = `dists/${pocket.pocket}/${component.sourceIndex.path}`;
  const originalIndex = archive.get(sourceIndexPath);
  const sourceFilename = fixture.capture.sources.packages[0].files[0].filename;
  const changedIndex = gzipSync(Buffer.from(
    gunzipSync(originalIndex).toString('utf8').replace(` ${sourceFilename}`, ` ../${sourceFilename}`),
    'utf8',
  ), { level: 9, mtime: 0 });
  archive.set(sourceIndexPath, changedIndex);
  const inReleasePath = pocket.inRelease.path;
  const originalChecksum = `${sha256(originalIndex)} ${originalIndex.length} ${component.sourceIndex.path}`;
  const changedChecksum = `${sha256(changedIndex)} ${changedIndex.length} ${component.sourceIndex.path}`;
  archive.set(inReleasePath, Buffer.from(
    archive.get(inReleasePath).toString('utf8').replace(originalChecksum, changedChecksum),
    'utf8',
  ));
  const requested = [];
  try {
    await assert.rejects(captureUbuntuPackageCapsule({
      policy: policy(fixture.capture), solution: solution(fixture.capture),
      destination: path.join(fixtureRoot, 'capture'),
      readArchive: async (request) => { requested.push(request.path); return reader(archive)(request); },
      verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
    }), /Sources Checksums-Sha256 filename is invalid/u);
    assert.equal(requested.some((entry) => entry.includes('../')), false);
    assert.equal(requested.some((entry) => entry.endsWith('.dsc') || entry.endsWith('.tar.xz')), false);
  } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
});

test('capture keeps setup, provider, construction, and origin policy outside its release LEGO', async () => {
  const source = await readFile(new URL('../src/release/ubuntu-package-capsule-capture.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['snapshot.ubuntu.com', 'archive.ubuntu.com', 'setup --construct', 'Hyper-V', 'libvirt', 'Start-VM']) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'u'));
  }
});
