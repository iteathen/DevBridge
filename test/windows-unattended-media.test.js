import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsUnattendedMediaPreparer } from '../src/runtime/image-builders/windows-unattended-media.js';

const SUBJECT = 'subject-0123456789abcdef0123456789abcdef';
const SECRET = 'A strong temporary secret 42!';

function admission() {
  return {
    protocol: 'devbridge/windows-install-media-authority-v1',
    media: { name: 'windows.iso', bytes: 12, sha256: 'a'.repeat(64) },
    approval: { sourceClass: 'official-owned', expectedSha256: 'a'.repeat(64), reference: 'https://www.microsoft.com/software-download/windows11', temporary: false },
    image: { container: 'wim', index: 6, name: 'Windows 11 Pro', edition: 'Professional', architecture: 'amd64', version: '10.0.26100.1', build: 26100, installationType: 'Client', languages: ['en-US'], defaultLanguage: 'en-US' },
  };
}

test('Windows unattended media binds admitted bytes, observed image, exact recipe, and output media', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-unattended-media-'));
  const source = path.join(root, 'windows.iso');
  const destination = path.join(root, 'prepared');
  const events = [];
  try {
    await writeFile(source, 'source-media');
    const preparer = new WindowsUnattendedMediaPreparer({
      admission: { lookup: async (subject) => { events.push(['lookup', subject]); return admission(); } },
      observer: { inspect: async (request) => { events.push(['inspect', request]); return { protocol: 'devbridge/windows-install-media-observation-v1', media: admission().media, image: admission().image }; } },
      seedFactory: (request) => {
        events.push(['seed', request]);
        return { protocol: 'devbridge/windows-unattended-seed-v1', files: [{ path: 'Autounattend.xml', content: `<secret>${request.access.secret}</secret>` }], evidence: { protocol: 'devbridge/windows-unattended-seed-v1', sha256: 'b'.repeat(64) } };
      },
      mediaWriter: { create: async (request) => { events.push(['write', request]); await writeFile(request.destination, 'seed-media'); return { location: request.destination, bytes: 10, sha256: 'c'.repeat(64), volumeLabel: request.volumeLabel, fileCount: request.files.length }; } },
    });
    const result = await preparer.prepare({ subject: SUBJECT, source, destination, access: { user: 'Administrator', secret: SECRET } });
    assert.deepEqual(events.map(([name]) => name), ['lookup', 'inspect', 'seed', 'write']);
    assert.deepEqual(events[1][1], { location: source, expectedSha256: 'a'.repeat(64), index: 6 });
    assert.equal(events[3][1].volumeLabel, 'DB_SETUP');
    assert.equal(events[3][1].files[0].content.includes(SECRET), true);
    assert.deepEqual(result.installer, { location: source, bytes: 12, sha256: 'a'.repeat(64) });
    assert.deepEqual(result.seed, { location: path.join(destination, 'answer.iso'), bytes: 10, sha256: 'c'.repeat(64), volumeLabel: 'DB_SETUP' });
    assert.equal(JSON.stringify(result.evidence).includes(SECRET), false);
    assert.equal(result.evidence.admissionReference, SUBJECT);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows unattended media removes only its new output directory on mismatch or writer failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-win-unattended-fail-'));
  const source = path.join(root, 'windows.iso');
  try {
    await writeFile(source, 'source-media');
    let writes = 0;
    const preparer = new WindowsUnattendedMediaPreparer({
      admission: { lookup: async () => admission() },
      observer: { inspect: async () => ({ protocol: 'devbridge/windows-install-media-observation-v1', media: admission().media, image: { ...admission().image, build: 22631, version: '10.0.22631.1' } }) },
      seedFactory: () => { throw new Error('must not create a seed'); },
      mediaWriter: { create: async () => { writes += 1; } },
    });
    const destination = path.join(root, 'prepared');
    await assert.rejects(() => preparer.prepare({ subject: SUBJECT, source, destination, access: { user: 'Administrator', secret: SECRET } }), /does not match admitted authority/u);
    assert.equal(writes, 0);
    assert.deepEqual(await readdir(root), ['windows.iso']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows unattended media connector exposes only neutral local studs', async () => {
  const sourceText = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/runtime/image-builders/windows-unattended-media.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(sourceText, /HyperV|libvirt|GitHub|repository[A-Z]|product.?key|DPAPI|Codex|CUDA/iu);
});
