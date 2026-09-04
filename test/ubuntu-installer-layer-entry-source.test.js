import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UbuntuInstallerLayerEntrySource } from '../src/release/ubuntu-installer-layer-entry-source.mjs';

const STATUS = Buffer.from('Package: base\nStatus: install ok installed\nArchitecture: amd64\nVersion: 1\n');
const KEYRING = Buffer.from('keyring');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-ubuntu-installer-layers-'));
  const destination = path.join(root, 'workspace');
  const media = path.join(root, 'ubuntu.iso');
  const xorriso = path.join(root, 'xorriso');
  const unsquashfs = path.join(root, 'unsquashfs');
  await mkdir(destination);
  await Promise.all([
    writeFile(media, Buffer.alloc(512, 1)),
    writeFile(xorriso, 'tool'),
    writeFile(unsquashfs, 'tool'),
  ]);
  return { root, destination, media, xorriso, unsquashfs };
}

function request(f) {
  return {
    destination: f.destination,
    media: f.media,
    mediaSha256: 'a'.repeat(64),
    mediaBytes: 512,
    installSource: 'ubuntu-server',
    leafLayer: 'ubuntu-server-minimal.ubuntu-server',
    orderedLayers: ['ubuntu-server-minimal', 'ubuntu-server-minimal.ubuntu-server'],
    signal: null,
  };
}

test('installer source extracts exact ordered layers and selects entries from the highest declaring layer', async () => {
  const f = await fixture();
  const calls = [];
  try {
    const source = new UbuntuInstallerLayerEntrySource({
      xorriso: f.xorriso,
      unsquashfs: f.unsquashfs,
      async run(executable, args, options) {
        calls.push({ executable, args, options });
        if (executable === f.xorriso) {
          await writeFile(args.at(-1), `squashfs:${path.basename(args.at(-1))}`);
          return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from('xorriso evidence') };
        }
        const [operation, layer, entry] = args;
        assert.equal(operation, '-cat');
        if (entry === 'var/lib/dpkg/status' && layer.includes('ubuntu-server.squashfs')) {
          return { code: 0, signal: null, stdout: STATUS, stderr: Buffer.alloc(0) };
        }
        if (entry === 'usr/share/keyrings/ubuntu-archive-keyring.gpg' && layer.endsWith('ubuntu-server-minimal.squashfs')) {
          return { code: 0, signal: null, stdout: KEYRING, stderr: Buffer.alloc(0) };
        }
        return { code: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from('entry absent') };
      },
    });
    const result = await source.materialize(request(f));
    assert.deepEqual(result.layers, request(f).orderedLayers);
    assert.equal(result.statusLayer, 'ubuntu-server-minimal.ubuntu-server');
    assert.equal(result.keyringLayer, 'ubuntu-server-minimal');
    assert.deepEqual(await readFile(result.statusFile), STATUS);
    assert.deepEqual(await readFile(result.keyringFile), KEYRING);
    assert.equal(result.layerFiles.length, 2);
    assert.ok(calls.every(({ options }) => options.signal == null));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('installer source rejects extraction failure without inventing an entry', async () => {
  const f = await fixture();
  try {
    const source = new UbuntuInstallerLayerEntrySource({
      xorriso: f.xorriso,
      unsquashfs: f.unsquashfs,
      async run(executable, args) {
        if (executable === f.xorriso) {
          await writeFile(args.at(-1), 'layer');
          return { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        return { code: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from('absent') };
      },
    });
    await assert.rejects(source.materialize(request(f)), /dpkg status is absent/u);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
