import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsInstallMediaSource } from '../src/runtime/image-sources/windows-install-media-source.js';

function registry() {
  const values = new Map();
  return {
    load: async (key) => structuredClone(values.get(key)),
    save: async (key, value) => { values.set(key, structuredClone(value)); },
    list: async () => [...values].map(([reference, value]) => ({ reference, value: structuredClone(value) })),
    size: () => values.size,
  };
}

function inventory(name, bytes) {
  return {
    protocol: 'devbridge/windows-install-media-inventory-v1',
    media: { name, bytes, sha256: 'a'.repeat(64) },
    images: [{
      container: 'wim', index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64',
      version: '10.0.26100.1', build: 26100, installationType: 'Client', languages: ['en-US'], defaultLanguage: 'en-US',
    }],
  };
}

test('Windows media source discovers bounded real ISO files and projects only opaque references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-media-source-'));
  try {
    const sources = path.join(root, 'sources');
    await mkdir(sources);
    const location = path.join(sources, 'Windows.iso');
    await writeFile(location, 'exact-media');
    const canonicalLocation = await realpath(location);
    await writeFile(path.join(sources, 'ignore.txt'), 'not-media');
    const state = registry();
    const calls = [];
    const source = new WindowsInstallMediaSource({
      roots: [sources], registry: state, platform: 'win32', invoke: async () => {},
      inspectorFactory: ({ sourceRoot }) => ({
        async inventory(request) { calls.push({ sourceRoot, ...request }); return inventory('Windows.iso', 11); },
      }),
    });

    const listed = await source.list();
    assert.equal(listed.length, 1);
    assert.match(listed[0].reference, /^source-[a-f0-9]{32}$/u);
    assert.equal(JSON.stringify(listed).includes(root), false);
    assert.equal((await source.inventory(listed[0].reference)).media.name, 'Windows.iso');
    assert.equal(calls[0].location, canonicalLocation);
    assert.equal((await source.resolve(listed[0].reference)).location, canonicalLocation);
    await writeFile(path.join(sources, 'later.iso'), 'later-media');
    await source.resolve(listed[0].reference);
    assert.equal(state.size(), 1);

    const resumed = new WindowsInstallMediaSource({
      registry: state, platform: 'win32', invoke: async () => {},
      inspectorFactory: () => ({ async inventory() { return inventory('Windows.iso', 11); } }),
    });
    assert.equal((await resumed.list())[0].reference, listed[0].reference);
    assert.equal(state.size(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows media source rejects unsupported hosts, non-ISO selections, and candidate fanout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-media-source-boundary-'));
  try {
    const text = path.join(root, 'value.txt');
    await writeFile(text, 'value');
    const state = registry();
    const inspectorFactory = () => ({ async inventory() { return inventory('Windows.iso', 1); } });
    const unsupported = new WindowsInstallMediaSource({ registry: state, platform: 'linux', invoke: async () => {}, inspectorFactory });
    await assert.rejects(() => unsupported.list(), /requires a Windows host/u);
    const invalid = new WindowsInstallMediaSource({ locations: [text], registry: state, platform: 'win32', invoke: async () => {}, inspectorFactory });
    await assert.rejects(() => invalid.list(), /real ISO file/u);

    const many = path.join(root, 'many');
    await mkdir(many);
    await Promise.all(Array.from({ length: 17 }, (_, index) => writeFile(path.join(many, `value-${index}.iso`), 'x')));
    const bounded = new WindowsInstallMediaSource({ roots: [many], registry: registry(), platform: 'win32', invoke: async () => {}, inspectorFactory });
    await assert.rejects(() => bounded.list(), /candidate bound/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
