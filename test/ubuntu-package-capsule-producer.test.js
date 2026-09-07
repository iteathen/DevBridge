import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyUbuntuPackageCapsuleReleaseInput } from '../src/setup/ubuntu-package-capsule-release-input.mjs';
import {
  UBUNTU_PACKAGE_CAPSULE_PRODUCTION_PROTOCOL,
  UbuntuPackageCapsuleProducer,
} from '../src/release/ubuntu-package-capsule-producer.mjs';
import { createUbuntuPackageCaptureFixture } from './fixtures/ubuntu-package-capsule-capture-fixture.js';

function policy(capture) {
  return { installSource: 'ubuntu-server-minimal', ...Object.fromEntries([
    'distribution', 'release', 'codename', 'architecture', 'snapshot', 'baseMediaSha256',
    'releaseId', 'sequence', 'upstreamKeyFingerprint',
  ].map((name) => [name, capture[name]])) };
}

function solution(capture) {
  const selectedPackages = capture.binaries.packages.map(({ package: packageName, version, architecture }) => ({
    package: packageName, version, architecture,
  }));
  return {
    protocol: 'devbridge/ubuntu-apt-transaction-solution-v1',
    snapshot: capture.snapshot,
    architecture: capture.architecture,
    basePackages: [{ package: 'libc6', version: '2.40-1ubuntu1', architecture: 'amd64' }],
    resultPackages: selectedPackages,
    selectedPackages,
    requestedPackages: selectedPackages.filter((entry) => ['build-essential', 'cmake'].includes(entry.package)),
  };
}

async function archiveFrom(fixture) {
  const bytes = new Map();
  const locations = new Map(Object.values(fixture.artifacts).flat().map((entry) => [entry.name, entry.location]));
  for (const pocket of fixture.capture.metadata.pockets) {
    bytes.set(pocket.inRelease.path, await readFile(locations.get(pocket.inRelease.object)));
    for (const component of pocket.components) {
      bytes.set(`dists/${pocket.pocket}/${component.binaryIndex.path}`, await readFile(locations.get(component.binaryIndex.object)));
      bytes.set(`dists/${pocket.pocket}/${component.sourceIndex.path}`, await readFile(locations.get(component.sourceIndex.object)));
    }
  }
  for (const binary of fixture.capture.binaries.packages) {
    bytes.set(binary.filename, await readFile(locations.get(binary.object)));
  }
  for (const source of fixture.capture.sources.packages) {
    for (const entry of [source.dsc, ...source.files]) {
      bytes.set(`${source.directory}/${entry.filename}`, await readFile(locations.get(entry.object)));
    }
  }
  return bytes;
}

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyBytes: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    publicKeyBytes: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })),
  };
}

test('producer composes exact solve, archive capture, Canonical verification, sealing, and capture cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-capsule-production-'));
  try {
    const fixture = await createUbuntuPackageCaptureFixture(path.join(root, 'fixture'));
    const archive = await archiveFrom(fixture);
    const solved = solution(fixture.capture);
    const observed = [];
    const solverRequest = {
      workspace: path.join(root, 'unused-workspace'),
      configurationFile: path.join(root, 'unused-apt.conf'),
      statusFile: path.join(root, 'unused-status'),
      sourcesListFile: path.join(root, 'unused-sources.list'),
      sourcePartsDirectory: path.join(root, 'unused-sources.list.d'),
      listsDirectory: path.join(root, 'unused-lists'),
      snapshot: fixture.capture.snapshot,
      architecture: fixture.capture.architecture,
      requestedPackages: ['build-essential', 'cmake'],
    };
    const producer = new UbuntuPackageCapsuleProducer({
      async verifyPreparation(preparation) {
        observed.push(['admit', preparation.protocol]);
        return preparation.solverRequest;
      },
      solver: {
        async solve(request) {
          observed.push(['solve', request.snapshot, request.architecture]);
          return solved;
        },
      },
      archiveSource: {
        async read(request) {
          observed.push(['read', request.path]);
          const selected = archive.get(request.path);
          if (!selected) throw new Error(`archive fixture path is absent: ${request.path}`);
          return selected;
        },
      },
      inReleaseVerifier: {
        async verify(request) {
          observed.push(['verify', request.context]);
          return { verified: true, fingerprint: request.expectedFingerprint };
        },
      },
    });
    const captureDestination = path.join(root, 'capture');
    const releaseDestination = path.join(root, 'release');
    const signingKeys = keys();
    const result = await producer.produce({
      policy: policy(fixture.capture),
      solverRequest,
      preparation: { protocol: 'fixture-preparation', solverRequest },
      captureDestination,
      releaseDestination,
      keyId: 'production-test-key',
      ...signingKeys,
      chunkBytes: 257,
    });
    assert.equal(result.protocol, UBUNTU_PACKAGE_CAPSULE_PRODUCTION_PROTOCOL);
    assert.equal(result.release.root, releaseDestination);
    assert.equal(result.release.snapshot, fixture.capture.snapshot);
    assert.equal(result.solution.selectedPackages, solved.selectedPackages.length);
    assert.ok(result.capture.artifactCount > 0);
    assert.deepEqual(observed.slice(0, 2).map(([name]) => name), ['admit', 'solve']);
    assert.ok(observed.findIndex(([name]) => name === 'read') > 0);
    assert.ok(observed.filter(([name]) => name === 'verify').length >= 6);
    await assert.rejects(lstat(captureDestination), /ENOENT/u);
    const accepted = verifyUbuntuPackageCapsuleReleaseInput({
      manifestBytes: await readFile(path.join(releaseDestination, result.release.manifestName)),
      publicKeyBytes: await readFile(path.join(releaseDestination, result.release.publicKeyName)),
      expectedManifestSha256: result.release.manifestSha256,
      expectedPublicKeySha256: result.release.publicKeySha256,
      expectedKeyId: result.release.keyId,
    });
    assert.equal(accepted.releaseId, fixture.capture.releaseId);
    assert.equal(accepted.installSource, 'ubuntu-server-minimal');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('producer rejects split authority and overlapping output before solving', async () => {
  let solves = 0;
  const producer = new UbuntuPackageCapsuleProducer({
    verifyPreparation: async (preparation) => preparation.solverRequest,
    solver: { async solve() { solves += 1; return {}; } },
    archiveSource: { async read() { return Buffer.of(1); } },
    inReleaseVerifier: { async verify() { return {}; } },
    capture: async () => ({}),
    seal: async () => ({}),
  });
  const root = path.resolve(os.tmpdir(), 'db-ubuntu-capsule-production-invalid');
  const request = {
    policy: {
      distribution: 'ubuntu', release: '26.04', codename: 'resolute', architecture: 'amd64',
      snapshot: '20260821T230000Z', baseMediaSha256: 'a'.repeat(64), releaseId: 'release-1',
      sequence: 1, upstreamKeyFingerprint: 'A'.repeat(40), installSource: 'ubuntu-server-minimal',
    },
    solverRequest: {
      workspace: path.join(root, 'workspace'), configurationFile: path.join(root, 'apt.conf'),
      statusFile: path.join(root, 'status'), sourcesListFile: path.join(root, 'sources.list'),
      sourcePartsDirectory: path.join(root, 'sources.list.d'), listsDirectory: path.join(root, 'lists'),
      snapshot: '20260822T230000Z', architecture: 'amd64', requestedPackages: ['cmake'],
    },
    captureDestination: path.join(root, 'capture'), releaseDestination: path.join(root, 'release'),
  };
  request.preparation = { solverRequest: request.solverRequest };
  const { installSource, ...unboundPolicy } = request.policy;
  await assert.rejects(producer.produce({ ...request, policy: unboundPolicy }), /installation source is invalid/u);
  await assert.rejects(producer.produce(request), /policy does not match its solver input/u);
  request.solverRequest.snapshot = request.policy.snapshot;
  request.preparation.solverRequest = { ...request.solverRequest, requestedPackages: ['git'] };
  await assert.rejects(producer.produce(request), /does not match its preparation/u);
  request.preparation.solverRequest = request.solverRequest;
  request.releaseDestination = path.join(request.captureDestination, 'release');
  await assert.rejects(producer.produce(request), /separate non-nested roots/u);
  assert.equal(solves, 0);
});

for (const failure of ['sealing failure', 'capture source substitution', 'sealed source substitution']) {
test(`producer removes only its completed capture after ${failure}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-capsule-production-fail-'));
  const captureDestination = path.join(root, 'capture');
  const releaseDestination = path.join(root, 'release');
  try {
    const producer = new UbuntuPackageCapsuleProducer({
      verifyPreparation: async (preparation) => preparation.solverRequest,
      solver: {
        async solve() {
          return {
            protocol: 'devbridge/ubuntu-apt-transaction-solution-v1',
            snapshot: '20260821T230000Z',
            architecture: 'amd64',
            basePackages: [{ package: 'base', version: '1', architecture: 'amd64' }],
            resultPackages: [
              { package: 'base', version: '1', architecture: 'amd64' },
              { package: 'cmake', version: '2', architecture: 'amd64' },
            ],
            selectedPackages: [{ package: 'cmake', version: '2', architecture: 'amd64' }],
            requestedPackages: [{ package: 'cmake', version: '2', architecture: 'amd64' }],
          };
        },
      },
      archiveSource: { async read() { return Buffer.of(1); } },
      inReleaseVerifier: { async verify() { return {}; } },
      capture: async () => {
        await mkdir(captureDestination);
        return { root: captureDestination, capture: { installSource: failure === 'capture source substitution' ? 'ubuntu-server' : 'ubuntu-server-minimal' }, artifacts: {}, artifactCount: 1, bytes: 1 };
      },
      seal: async () => {
        assert.notEqual(failure, 'capture source substitution', 'substituted capture must not reach the sealer');
        if (failure === 'sealing failure') throw new Error('bounded sealer failure');
        return { root: releaseDestination, snapshot: '20260821T230000Z', releaseId: 'release-1', sequence: 1, installSource: 'ubuntu-server' };
      },
    });
    const solverRequest = {
      workspace: path.join(root, 'workspace'), configurationFile: path.join(root, 'apt.conf'),
      statusFile: path.join(root, 'status'), sourcesListFile: path.join(root, 'sources.list'),
      sourcePartsDirectory: path.join(root, 'sources.list.d'), listsDirectory: path.join(root, 'lists'),
      snapshot: '20260821T230000Z', architecture: 'amd64', requestedPackages: ['cmake'],
    };
    await assert.rejects(producer.produce({
      policy: {
        distribution: 'ubuntu', release: '26.04', codename: 'resolute', architecture: 'amd64',
        snapshot: '20260821T230000Z', baseMediaSha256: 'a'.repeat(64), releaseId: 'release-1',
        sequence: 1, upstreamKeyFingerprint: 'A'.repeat(40), installSource: 'ubuntu-server-minimal',
      },
      solverRequest,
      preparation: { solverRequest },
      captureDestination,
      releaseDestination,
    }), failure === 'sealing failure' ? /bounded sealer failure/u
      : failure === 'capture source substitution' ? /capture installation source changed/u : /sealer returned mismatched release evidence/u);
    await assert.rejects(lstat(captureDestination), /ENOENT/u);
    await assert.rejects(lstat(releaseDestination), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
}

test('producer remains release-owned while the CLI performs only explicit concrete composition', async () => {
  const [producer, script] = await Promise.all([
    readFile(new URL('../src/release/ubuntu-package-capsule-producer.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build-ubuntu-package-capsule-production.mjs', import.meta.url), 'utf8'),
  ]);
  for (const source of [producer, script]) {
    for (const forbidden of ['setup --construct', 'Hyper-V', 'libvirt', 'Start-VM', 'prepareRuntimeCandidate']) {
      assert.doesNotMatch(source, new RegExp(forbidden, 'u'));
    }
  }
  assert.doesNotMatch(producer, /snapshot\.ubuntu\.com/u);
  assert.match(script, /UbuntuAptTransactionSolver/u);
  assert.match(script, /UbuntuSnapshotArchiveHttpsSource/u);
  assert.match(script, /GpgvInReleaseVerifier/u);
});
