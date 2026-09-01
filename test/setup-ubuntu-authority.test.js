import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  createUbuntuSetupAuthority,
  defaultUbuntuPackageSnapshot,
  resolveUbuntuPackagePins,
  deriveCurrentUbuntuSetupAuthority,
  UBUNTU_SETUP_BOOT_PATCH,
} from '../src/setup/ubuntu-authority.js';
import { createGuestImagePayload } from '../src/guest/image-payload.js';

const SNAPSHOT = '20260821T200000Z';
const CURRENT_PAYLOAD_GENERATION = 'guest-image-6c102cff53ad6d9f10f03530';

function index(entries) {
  return gzipSync(Buffer.from(entries.map(([name, version]) => `Package: ${name}\nVersion: ${version}\nArchitecture: amd64\n`).join('\n'), 'utf8'));
}

function responseFor(url) {
  let entries = [];
  if (url.includes('/resolute/main/')) entries = [['build-essential', '12.12ubuntu1'], ['cmake', '3.31.6-1'], ['git', '1:2.48.1-0ubuntu1'], ['linux-cloud-tools-virtual', '7.0.0-14.14'], ['openssh-server', '1:9.9p1-3ubuntu3']];
  else if (url.includes('/resolute/universe/')) entries = [['nodejs', '22.16.0+dfsg-1'], ['npm', '10.9.2+ds-1']];
  else if (url.includes('/resolute-updates/main/')) entries = [['build-essential', '12.12ubuntu1.26.04.2'], ['linux-cloud-tools-virtual', '7.0.0-30.30']];
  else if (url.includes('/resolute-security/main/')) entries = [['build-essential', '12.12ubuntu1.26.04.1'], ['linux-cloud-tools-virtual', '7.0.0-29.29']];
  const body = index(entries);
  return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
}

test('setup snapshot choice is exact and deliberately lagged from the current clock', () => {
  assert.equal(defaultUbuntuPackageSnapshot(new Date('2026-08-23T20:45:00Z')), SNAPSHOT);
});

test('setup resolves every required package from the exact snapshot without fixture pins', async () => {
  const requests = [];
  const packages = await resolveUbuntuPackagePins({
    snapshot: SNAPSHOT,
    fetchImpl: async (url) => { requests.push(String(url)); return responseFor(String(url)); },
  });
  assert.equal(requests.length, 6);
  assert.deepEqual(new Set(requests.map((url) => url.match(/\/dists\/(resolute(?:-updates|-security)?)\//u)?.[1])), new Set(['resolute', 'resolute-updates', 'resolute-security']));
  assert.deepEqual(packages, [
    { name: 'build-essential', version: '12.12ubuntu1.26.04.2' },
    { name: 'cmake', version: '3.31.6-1' },
    { name: 'git', version: '1:2.48.1-0ubuntu1' },
    { name: 'linux-cloud-tools-virtual', version: '7.0.0-30.30' },
    { name: 'nodejs', version: '22.16.0+dfsg-1' },
    { name: 'npm', version: '10.9.2+ds-1' },
    { name: 'openssh-server', version: '1:9.9p1-3ubuntu3' },
  ]);
});

test('setup authority binds source policy, exact snapshot and current payload generation', async () => {
  const authority = await createUbuntuSetupAuthority({
    snapshot: SNAPSHOT,
    fetchImpl: async (url) => responseFor(String(url)),
    payloadFactory: async () => ({ generation: CURRENT_PAYLOAD_GENERATION }),
  });
  assert.equal(authority.source.media.sha256, 'dec49008a71f6098d0bcfc822021f4d042d5f2db279e4d75bdd981304f1ca5d9');
  assert.equal(authority.source.media.bytes, 2_918_598_656);
  assert.equal(authority.packages.snapshot, SNAPSHOT);
  assert.equal(authority.packages.generation, 'ubuntu-2604-tools-v4');
  assert.equal(authority.packages.packages.find((entry) => entry.name === 'openssh-server')?.version, '1:9.9p1-3ubuntu3');
  assert.deepEqual(authority.qualification.commands, ['hv_kvp_daemon', 'make']);
  assert.equal(authority.payload.generation, CURRENT_PAYLOAD_GENERATION);
  assert.equal(authority.recipe.generation, 'ubuntu-2604-autoinstall-v10');
  assert.equal(authority.output.generation, 'ubuntu-2604-production-v6');
  assert.deepEqual(authority.recipe.patches, [{ id: 'boot-trigger', occurrences: 2, ...UBUNTU_SETUP_BOOT_PATCH }]);
});

test('setup output generation is bound to the exact current semantic payload', async () => {
  const payload = await createGuestImagePayload();
  assert.equal(payload.generation, CURRENT_PAYLOAD_GENERATION);
  await assert.rejects(
    () => createUbuntuSetupAuthority({
      snapshot: SNAPSHOT,
      fetchImpl: async (url) => responseFor(String(url)),
      payloadFactory: async () => ({ generation: 'guest-image-ffffffffffffffffffffffff' }),
    }),
    /payload generation is not bound to the Ubuntu output generation/u,
  );
});

test('setup derives the exact current authority from one durable local package set without network resolution', async () => {
  const authority = await createUbuntuSetupAuthority({
    snapshot: SNAPSHOT,
    fetchImpl: async (url) => responseFor(String(url)),
    payloadFactory: async () => ({ generation: CURRENT_PAYLOAD_GENERATION }),
  });
  const historical = structuredClone(authority);
  historical.output.generation = 'ubuntu-2604-production-v4';
  const selected = await deriveCurrentUbuntuSetupAuthority({
    snapshot: SNAPSHOT,
    authorities: [historical, authority],
    payloadFactory: async () => ({ generation: CURRENT_PAYLOAD_GENERATION }),
  });
  assert.deepEqual(selected, authority);
  const conflicting = structuredClone(authority);
  conflicting.packages.packages[0].version = `${conflicting.packages.packages[0].version}.1`;
  await assert.rejects(
    () => deriveCurrentUbuntuSetupAuthority({
      snapshot: SNAPSHOT,
      authorities: [authority, conflicting],
      payloadFactory: async () => ({ generation: CURRENT_PAYLOAD_GENERATION }),
    }),
    /observed 2/u,
  );
});

test('setup uses an exact 83-byte invariant boot prefix without changing ISO length', () => {
  assert.equal(Buffer.byteLength(UBUNTU_SETUP_BOOT_PATCH.before, 'utf8'), 83);
  assert.equal(Buffer.byteLength(UBUNTU_SETUP_BOOT_PATCH.after, 'utf8'), 83);
  assert.match(UBUNTU_SETUP_BOOT_PATCH.before, /^Try or Install Ubuntu Server/u);
  assert.match(UBUNTU_SETUP_BOOT_PATCH.before, /linux  \/casper\/vmlinuz $/u);
  assert.match(UBUNTU_SETUP_BOOT_PATCH.after, /^Automated Install/u);
  assert.match(UBUNTU_SETUP_BOOT_PATCH.after, /linux  \/casper\/vmlinuz autoinstall$/u);
});

test('setup boot patch matches both admitted raw boot prefixes while ignoring divergent suffixes', () => {
  const first = [
    'menuentry "Try or Install Ubuntu Server" {',
    '    set gfxpayload=keep',
    '    linux  /casper/vmlinuz   ---',
    '    initrd /casper/initrd',
    '}',
  ].join('\n');
  const second = [
    'menuentry "Try or Install Ubuntu Server" {',
    '    set gfxpayload=keep',
    '    linux  /casper/vmlinuz   quiet splash ---',
    '    initrd    --no-floppy /casper/initrd',
    '}',
  ].join('\n');
  const raw = `prefix\n${first}\nmiddle\n${second}\nsuffix`;
  assert.equal(raw.split(UBUNTU_SETUP_BOOT_PATCH.before).length - 1, 2);
  const patched = raw.split(UBUNTU_SETUP_BOOT_PATCH.before).join(UBUNTU_SETUP_BOOT_PATCH.after);
  assert.equal(patched.length, raw.length);
  assert.equal((patched.match(/Automated Install/gu) ?? []).length, 2);
  assert.equal((patched.match(/\/casper\/vmlinuz autoinstall/gu) ?? []).length, 2);
});

test('setup package resolution fails closed when the snapshot is incomplete', async () => {
  await assert.rejects(
    () => resolveUbuntuPackagePins({ snapshot: SNAPSHOT, fetchImpl: async () => new Response(index([['git', '1:2.48.1-0ubuntu1']]), { status: 200 }) }),
    /does not contain required setup packages/u,
  );
});
