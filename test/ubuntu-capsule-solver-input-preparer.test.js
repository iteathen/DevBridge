import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  UBUNTU_CAPSULE_SOLVER_INPUT_PREPARATION_PROTOCOL,
  UbuntuCapsuleSolverInputPreparer,
} from '../src/release/ubuntu-capsule-solver-input-preparer.mjs';
import { UBUNTU_APT_ISOLATED_CONFIGURATION } from '../src/release/ubuntu-apt-transaction-solver.mjs';

const SNAPSHOT = '20260821T230000Z';
const CODENAME = 'resolute';
const ARCHITECTURE = 'amd64';
const STATUS = Buffer.from([
  'Package: base-files',
  'Status: install ok installed',
  'Architecture: amd64',
  'Version: 1.0-1ubuntu1',
  '',
].join('\n'));
const KEYRING = Buffer.from('bounded-test-keyring');

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function listNames() {
  const prefix = `snapshot.ubuntu.com_ubuntu_${SNAPSHOT}_dists_`;
  return [
    `${prefix}${CODENAME}-security_InRelease`,
    `${prefix}${CODENAME}-security_main_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}-security_universe_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}-updates_InRelease`,
    `${prefix}${CODENAME}-updates_main_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}-updates_universe_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}_InRelease`,
    `${prefix}${CODENAME}_main_binary-${ARCHITECTURE}_Packages`,
    `${prefix}${CODENAME}_universe_binary-${ARCHITECTURE}_Packages`,
  ];
}

function ports({ listMutation = null } = {}) {
  return {
    installer: {
      async materialize(request) {
        const statusFile = path.join(request.destination, 'status');
        const keyringFile = path.join(request.destination, 'ubuntu-archive-keyring.gpg');
        const layerFiles = [];
        for (const name of request.orderedLayers) {
          const location = path.join(request.destination, `${name}.squashfs`);
          await writeFile(location, `layer:${name}\n`, { flag: 'wx' });
          layerFiles.push({ name, location });
        }
        await Promise.all([
          writeFile(statusFile, STATUS, { flag: 'wx' }),
          writeFile(keyringFile, KEYRING, { flag: 'wx' }),
        ]);
        return {
          statusFile,
          statusLayer: 'ubuntu-server-minimal.ubuntu-server',
          keyringFile,
          keyringLayer: 'ubuntu-server-minimal',
          layers: request.orderedLayers,
          layerFiles,
        };
      },
    },
    snapshotLists: {
      async prepare(request) {
        const configurationFile = path.join(request.destination, 'apt.conf');
        const sourcesListFile = path.join(request.destination, 'sources.list');
        const sourcePartsDirectory = path.join(request.destination, 'source-parts');
        const listsDirectory = path.join(request.destination, 'lists');
        await Promise.all([mkdir(sourcePartsDirectory), mkdir(listsDirectory)]);
        await Promise.all([
          writeFile(configurationFile, UBUNTU_APT_ISOLATED_CONFIGURATION, { flag: 'wx' }),
          writeFile(sourcesListFile, request.sources, { flag: 'wx' }),
          ...listNames().map((name) => writeFile(path.join(listsDirectory, name), `fixture:${name}\n`, { flag: 'wx' })),
        ]);
        if (listMutation) await listMutation({ request, listsDirectory, configurationFile, sourcesListFile });
        return { configurationFile, sourcesListFile, sourcePartsDirectory, listsDirectory };
      },
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-solver-preparation-'));
  const media = path.join(root, 'ubuntu.iso');
  const mediaBytes = Buffer.alloc(256, 0x61);
  await writeFile(media, mediaBytes, { flag: 'wx' });
  return { root, media, mediaBytes };
}

function request(f, overrides = {}) {
  return {
    destination: path.join(f.root, 'prepared'),
    media: f.media,
    mediaSha256: hash(f.mediaBytes),
    mediaBytes: f.mediaBytes.byteLength,
    distribution: 'ubuntu',
    release: '26.04',
    codename: CODENAME,
    architecture: ARCHITECTURE,
    snapshot: SNAPSHOT,
    installSource: 'ubuntu-server',
    leafLayer: 'ubuntu-server-minimal.ubuntu-server',
    orderedLayers: ['ubuntu-server-minimal', 'ubuntu-server-minimal.ubuntu-server'],
    requestedPackages: ['cmake', 'build-essential'],
    ...overrides,
  };
}

test('preparer binds exact installer and snapshot evidence into one solver request and receipt', async () => {
  const f = await fixture();
  try {
    const result = await new UbuntuCapsuleSolverInputPreparer(ports()).prepare(request(f));
    assert.equal(result.protocol, UBUNTU_CAPSULE_SOLVER_INPUT_PREPARATION_PROTOCOL);
    assert.equal(result.root, path.join(f.root, 'prepared'));
    assert.equal(result.receipt.media.sha256, hash(f.mediaBytes));
    assert.equal(result.receipt.installer.statusSha256, hash(STATUS));
    assert.equal(result.receipt.installer.keyringSha256, hash(KEYRING));
    assert.equal(result.receipt.installer.statusLayer, 'ubuntu-server-minimal.ubuntu-server');
    assert.equal(result.receipt.installer.keyringLayer, 'ubuntu-server-minimal');
    assert.equal(result.receipt.installer.orderedLayers.length, 2);
    assert.match(result.receipt.installer.orderedLayers[0].sha256, /^[a-f0-9]{64}$/u);
    assert.equal(result.receipt.apt.lists.length, 9);
    assert.match(result.receipt.apt.listInventorySha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(result.solverRequest.requestedPackages, ['build-essential', 'cmake']);
    assert.equal(result.solverRequest.snapshot, SNAPSHOT);
    assert.deepEqual(JSON.parse(await readFile(result.receiptFile, 'utf8')), result.receipt);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preparer rejects authority drift and removes only its newly-created workspace', async () => {
  const f = await fixture();
  try {
    const preparer = new UbuntuCapsuleSolverInputPreparer(ports({
      listMutation: async ({ listsDirectory }) => {
        await writeFile(path.join(listsDirectory, 'live-host_Packages'), 'forbidden', { flag: 'wx' });
      },
    }));
    await assert.rejects(preparer.prepare(request(f)), /exact retained projection/u);
    await assert.rejects(lstat(path.join(f.root, 'prepared')), /ENOENT/u);
    assert.equal((await readFile(f.media, 'utf8')), f.mediaBytes.toString('utf8'));

    await assert.rejects(new UbuntuCapsuleSolverInputPreparer(ports()).prepare(
      request(f, { mediaSha256: '0'.repeat(64) }),
    ), /does not match its exact authority/u);
    await assert.rejects(lstat(path.join(f.root, 'prepared')), /ENOENT/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preparer refuses an existing destination and preserves it', async () => {
  const f = await fixture();
  const destination = path.join(f.root, 'prepared');
  try {
    await mkdir(destination);
    await writeFile(path.join(destination, 'owner.txt'), 'caller-owned');
    await assert.rejects(
      new UbuntuCapsuleSolverInputPreparer(ports()).prepare(request(f)),
      /EEXIST/u,
    );
    assert.equal(await readFile(path.join(destination, 'owner.txt'), 'utf8'), 'caller-owned');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
