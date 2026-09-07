import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { parseUbuntuSha256Checksum } from '../src/release/ubuntu-sha256-checksum.mjs';

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
    assert.ok(Number.isSafeInteger(request.maximum) && request.maximum > 0);
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

for (const emptyAncillaryIndex of [false, true]) {
test(`capture maps one solved transaction through signed metadata to exact binary and source artifacts (empty ancillary index: ${emptyAncillaryIndex})`, async () => {
  const { fixtureRoot, fixture, archive } = await input();
  if (emptyAncillaryIndex) {
    for (const pocket of fixture.capture.metadata.pockets) {
      archive.set(pocket.inRelease.path, Buffer.from(archive.get(pocket.inRelease.path).toString('utf8')
        .replace('SHA256:\n', `SHA256:\n ${sha256(Buffer.alloc(0))} 0 main/debian-installer/binary-amd64/Packages\n ${'a'.repeat(64)} 48777 main/dep11/icons-128x128@2.tar.gz\n`)));
    }
  }
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
}

test('checksum row grammar distinguishes empty InRelease entries from nonempty artifact authority', () => {
  const empty = sha256(Buffer.alloc(0));
  const row = `${empty} 0 main/debian-installer/binary-amd64/Packages`;
  assert.equal(parseUbuntuSha256Checksum(row), null);
  assert.equal(parseUbuntuSha256Checksum(row, { allowEmpty: true }).size, 0);
  for (const size of ['-1', '+0', '00', '01', '1.0', '1e3', '9007199254740992']) {
    assert.equal(parseUbuntuSha256Checksum(`${empty} ${size} file`, { allowEmpty: true }), null);
  }
  assert.equal(parseUbuntuSha256Checksum(`${'a'.repeat(64)} 0 file`, { allowEmpty: true }), null);
  assert.equal(parseUbuntuSha256Checksum(`${empty} 1 file`).size, 1);
  assert.equal(parseUbuntuSha256Checksum(`${empty} 9007199254740991 file`).size, Number.MAX_SAFE_INTEGER);
  assert.equal(parseUbuntuSha256Checksum(`${empty} 1 file extra`), null);
});

test('independent sealing accepts signed empty ancillary indexes without admitting empty artifact objects', async () => {
  const { fixtureRoot, fixture } = await input();
  try {
    const pocket = fixture.capture.metadata.pockets[0];
    const file = fixture.artifacts.metadata.find(entry => entry.name === pocket.inRelease.object).location;
    await writeFile(file, (await readFile(file, 'utf8')).replace('SHA256:\n',
      `SHA256:\n ${sha256(Buffer.alloc(0))} 0 main/debian-installer/binary-amd64/Packages\n`));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const sealed = await buildUbuntuPackageCapsuleRelease({
      capture: fixture.capture, artifacts: fixture.artifacts, destination: path.join(fixtureRoot, 'release'),
      keyId: 'empty-index-test',
      privateKeyBytes: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })),
      publicKeyBytes: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })),
      verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
    });
    assert.equal(sealed.keyId, 'empty-index-test');
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

for (const invalid of ['wrong-empty-digest', 'duplicate-empty-path', 'selected-empty-index']) {
  test(`both capture and independent sealing reject ${invalid} and preserve retryability`, async () => {
    const { fixtureRoot, fixture, archive } = await input();
    const pocket = fixture.capture.metadata.pockets[0];
    const original = archive.get(pocket.inRelease.path);
    const emptyRow = ` ${sha256(Buffer.alloc(0))} 0 main/debian-installer/binary-amd64/Packages\n`;
    let changed;
    if (invalid === 'wrong-empty-digest') {
      changed = original.toString('utf8').replace('SHA256:\n', `SHA256:\n ${'a'.repeat(64)} 0 ancillary\n`);
    } else if (invalid === 'duplicate-empty-path') {
      changed = original.toString('utf8').replace('SHA256:\n', `SHA256:\n${emptyRow}${emptyRow}`);
    } else {
      const indexPath = pocket.components[0].binaryIndex.path;
      const index = archive.get(`dists/${pocket.pocket}/${indexPath}`);
      changed = original.toString('utf8').replace(`${sha256(index)} ${index.length} ${indexPath}`,
        `${sha256(Buffer.alloc(0))} 0 ${indexPath}`);
    }
    archive.set(pocket.inRelease.path, Buffer.from(changed));
    const destination = path.join(fixtureRoot, 'capture');
    const releaseDestination = path.join(fixtureRoot, 'release');
    const inReleaseFile = fixture.artifacts.metadata.find(entry => entry.name === pocket.inRelease.object).location;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    try {
      const request = { policy: policy(fixture.capture), solution: solution(fixture.capture), destination,
        readArchive: reader(archive), verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint) };
      await assert.rejects(captureUbuntuPackageCapsule(request), /checksum|signed size and SHA-256/u);
      await assert.rejects(readFile(destination), /ENOENT/u);
      await writeFile(inReleaseFile, changed);
      await assert.rejects(buildUbuntuPackageCapsuleRelease({
        capture: fixture.capture, artifacts: fixture.artifacts, destination: releaseDestination,
        keyId: 'invalid-index-test',
        privateKeyBytes: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })),
        publicKeyBytes: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })),
        verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
      }), /checksum|upstream size and SHA-256/u);
      await assert.rejects(readFile(releaseDestination), /ENOENT/u);
      archive.set(pocket.inRelease.path, original);
      const retry = await captureUbuntuPackageCapsule(request);
      assert.equal(retry.artifactCount, 26);
    } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
  });
}

test('ancillary HiDPI index names do not weaken path containment or select extra downloads', async () => {
  const { fixtureRoot, fixture, archive } = await input();
  const pocket = fixture.capture.metadata.pockets[0], original = archive.get(pocket.inRelease.path);
  const paths = ['../icons@2.tar', '%2e%2e/icons@2.tar', 'main%2fdep11/icons@2.tar',
    'main%5cdep11/icons@2.tar', '/icons@2.tar', '//host/icons@2.tar',
    'https://host/icons@2.tar', 'main/icons@2.tar?redirect=1', 'main/icons@2.tar#fragment'];
  const destination = path.join(fixtureRoot, 'capture');
  try {
    for (const selectedPath of paths) {
      archive.set(pocket.inRelease.path, Buffer.from(original.toString('utf8').replace('SHA256:\n',
        `SHA256:\n ${'a'.repeat(64)} 123 ${selectedPath}\n`)));
      const requests = [];
      await assert.rejects(captureUbuntuPackageCapsule({
        policy: policy(fixture.capture), solution: solution(fixture.capture), destination,
        readArchive: async request => { requests.push(request.path); return reader(archive)(request); },
        verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
      }), /InRelease path is invalid/u);
      assert.deepEqual(requests, [pocket.inRelease.path]);
      await assert.rejects(readFile(destination), /ENOENT/u);
    }
    archive.set(pocket.inRelease.path, Buffer.from(original.toString('utf8').replace('SHA256:\n',
      `SHA256:\n ${'a'.repeat(64)} 123 main/dep11/icons-128x128@2.tar.gz\n`)));
    const requests = [];
    await captureUbuntuPackageCapsule({
      policy: policy(fixture.capture), solution: solution(fixture.capture), destination,
      readArchive: async request => { requests.push(request.path); return reader(archive)(request); },
      verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
    });
    assert.equal(requests.some(entry => entry.includes('@')), false);
  } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
});

for (const selectedOversize of [false, true]) {
  test(`binary size ceiling belongs to selected acquisition (selected oversized: ${selectedOversize})`, async () => {
    const { fixtureRoot, fixture, archive } = await input();
    for (const pocket of fixture.capture.metadata.pockets) {
      for (const component of pocket.components) {
        const indexPath = `dists/${pocket.pocket}/${component.binaryIndex.path}`;
        const original = archive.get(indexPath);
        let text = gunzipSync(original).toString('utf8');
        if (selectedOversize) text = text.replace(/\nSize: [0-9]+/u, '\nSize: 3197044082');
        else text += `\nPackage: qgis-api-doc\nVersion: 1.0\nArchitecture: all\nFilename: pool/universe/q/qgis/qgis-api-doc_1.0_all.deb\nSize: 3197044082\nSHA256: ${'a'.repeat(64)}\n`;
        const changed = gzipSync(Buffer.from(text), { level: 9, mtime: 0 });
        archive.set(indexPath, changed);
        archive.set(pocket.inRelease.path, Buffer.from(archive.get(pocket.inRelease.path).toString('utf8')
          .replace(`${sha256(original)} ${original.length} ${component.binaryIndex.path}`,
            `${sha256(changed)} ${changed.length} ${component.binaryIndex.path}`)));
      }
    }
    const destination = path.join(fixtureRoot, 'capture'), requests = [];
    try {
      const operation = captureUbuntuPackageCapsule({
        policy: policy(fixture.capture), solution: solution(fixture.capture), destination,
        readArchive: async request => { requests.push(request.path); return reader(archive)(request); },
        verifyInRelease: verifier(fixture.capture.upstreamKeyFingerprint),
      });
      if (selectedOversize) {
        await assert.rejects(operation, /exceeds its byte bound/u);
        assert.equal(requests.some(entry => entry.startsWith('pool/')), false);
        await assert.rejects(readFile(destination), /ENOENT/u);
      } else {
        const result = await operation;
        assert.equal(result.capture.binaries.packages.length, 3);
        assert.equal(requests.some(entry => entry.includes('qgis')), false);
      }
    } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
  });
}

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
