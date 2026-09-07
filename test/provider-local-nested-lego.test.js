import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HyperVConstructionRequest } from '../src/runtime/providers/hyperv-image-construction/request-contract.js';
import { HyperVConstructionObservation } from '../src/runtime/providers/hyperv-image-construction/observation.js';
import { HyperVInstallLiveness } from '../src/runtime/providers/hyperv-image-construction/install-liveness.js';

const providerRoot = fileURLToPath(new URL('../src/runtime/providers/', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const groups = {
  hypervEnvironment: [
    'hyperv-persistent-environment/environment-contract.js',
    'hyperv-persistent-environment/management-channel.js',
    'hyperv-persistent-environment/state-ledger.js',
    'hyperv-persistent-environment/storage-lineage.js',
  ],
  libvirtEnvironment: [
    'libvirt-persistent-environment/domain-channel.js',
    'libvirt-persistent-environment/environment-contract.js',
    'libvirt-persistent-environment/overlay-lineage.js',
    'libvirt-persistent-environment/state-ledger.js',
  ],
  hypervConstruction: [
    'hyperv-image-construction/console-evidence.js',
    'hyperv-image-construction/install-liveness.js',
    'hyperv-image-construction/management-channel.js',
    'hyperv-image-construction/media-admission.js',
    'hyperv-image-construction/observation.js',
    'hyperv-image-construction/request-contract.js',
    'hyperv-image-construction/state-ledger.js',
  ],
};

async function source(relative) { return readFile(path.join(providerRoot, relative), 'utf8'); }

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(location);
    return /\.(?:m?js)$/u.test(entry.name) ? [location] : [];
  }));
  return nested.flat();
}

test('provider-local nested LEGOs are sibling-independent and cross-provider isolated', async () => {
  for (const relative of Object.values(groups).flat()) {
    const text = await source(relative);
    assert.doesNotMatch(text, /from ['"]\.\.?\//u, `${relative} imported another local implementation`);
    assert.doesNotMatch(text, /github|codex|repository|remote agent/iu, `${relative} leaked external topology`);
  }
  for (const relative of [...groups.hypervEnvironment, ...groups.hypervConstruction]) {
    assert.doesNotMatch(await source(relative), /libvirt|qemu|qcow2|virsh/iu, `${relative} leaked another provider`);
  }
  for (const relative of groups.libvirtEnvironment) {
    assert.doesNotMatch(await source(relative), /hyper-?v|powershell|vhdx/iu, `${relative} leaked another provider`);
  }
});

test('only provider parents compose provider-local nested LEGOs', async () => {
  const allowed = new Set([
    path.join(providerRoot, 'hyperv-image-construction.js'),
    path.join(providerRoot, 'hyperv-persistent-environment-core.js'),
    path.join(providerRoot, 'libvirt-persistent-environment-core.js'),
  ].map((entry) => path.resolve(entry)));
  const nestedImport = /from ['"][^'"]*providers\/(?:hyperv-image-construction|hyperv-persistent-environment|libvirt-persistent-environment)\//u;
  for (const location of await sourceFiles(sourceRoot)) {
    const normalized = location.replaceAll('\\', '/');
    if (normalized.includes('/runtime/providers/hyperv-image-construction/')
        || normalized.includes('/runtime/providers/hyperv-persistent-environment/')
        || normalized.includes('/runtime/providers/libvirt-persistent-environment/')) continue;
    const text = await readFile(location, 'utf8');
    if (nestedImport.test(text)) assert.ok(allowed.has(path.resolve(location)), `${location} bypassed its provider parent`);
  }
});

test('construction request owner derives exact local identities without accepting topology', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-provider-request-'));
  try {
    const contract = new HyperVConstructionRequest({
      identity: 'a'.repeat(32),
      outputRoot: root,
      normalizeProtection: (value) => value ?? null,
    });
    const request = contract.normalize({
      identity: 'subject-0123456789abcdef0123456789abcdef',
      installer: { location: 'installer.iso', bytes: 1, sha256: '1'.repeat(64) },
      seed: { location: 'seed.iso', bytes: 1, sha256: '2'.repeat(64) },
      memoryBytes: 1024 * 1024 * 1024,
      processorCount: 2,
      diskBytes: 8 * 1024 * 1024 * 1024,
      network: { control: 'owned', reference: 'local-network', proof: 'local-proof' },
    });
    const record = { ...contract.create(request), ...request, phase: 'planned', providerIdentity: null };
    assert.equal(contract.same(record, request), true);
    assert.match(contract.descriptor(record).diskPath, /^[\s\S]*[a-f0-9]{64}\.vhdx$/u);
    assert.match(record.name, /^db-image-build-[a-f0-9]{16}$/u);
    await assert.rejects(async () => contract.normalize({ ...request, providerTarget: 'foreign' }), /providerTarget is not allowed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('construction observation and liveness owners reject malformed evidence locally', () => {
  const observation = new HyperVConstructionObservation();
  const record = { phase: 'installing', providerIdentity: 'provider-1' };
  const projected = observation.status('subject-0123456789abcdef0123456789abcdef', record, {
    exists: true, owned: true, compatible: true, providerIdentity: 'provider-1', state: 'running',
    mediaCount: 2, uptimeMilliseconds: 120_000, cpuUsagePercent: 10, providerStatus: 'steady', diskAllocatedBytes: 4096,
  });
  assert.equal(projected.state, 'running');
  assert.throws(() => observation.status(projected.identity, record, { ...projected, compatible: true, providerIdentity: 'provider-1', cpuUsagePercent: 101 }), /CPU observation is invalid/u);
  assert.deepEqual(observation.address({ ready: true, addresses: ['fe80::1', '172.20.1.2'] }), { ready: true, reason: null, address: '172.20.1.2' });
  assert.throws(() => observation.address({ ready: true, addresses: ['10.0.0.2', '192.168.0.2'] }), /ambiguous private IPv4/u);

  const owner = new HyperVInstallLiveness();
  const first = owner.checkpoint(null, projected, new Date('2026-08-28T12:00:00.000Z'));
  const stalled = owner.checkpoint(first, projected, new Date('2026-08-28T12:21:00.000Z'));
  assert.equal(first.classification, 'observing');
  assert.equal(stalled.classification, 'stalled');
  assert.equal(stalled.nextObservationAt, null);
  assert.throws(() => owner.checkpoint(first, projected, new Date('invalid')), /clock returned an invalid time/u);
});
