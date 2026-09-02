import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitBundleCheckout } from '../src/bootstrap/git-bundle-checkout.mjs';
import { SourceBundleMaterialization } from '../src/bootstrap/source-bundle-materialization.mjs';
import { ImmutableObjectAcquisition } from '../src/runtime/immutable-object-acquisition.js';
import { FilesystemImmutableObjectSource } from '../src/runtime/immutable-object-sources/filesystem.js';
import {
  SOURCE_BUNDLE_RELEASE_MANIFEST_NAME,
  SOURCE_BUNDLE_RELEASE_OBJECT_DIRECTORY,
  SOURCE_BUNDLE_RELEASE_PUBLIC_KEY_NAME,
  buildSourceBundleRelease,
} from '../src/release/source-bundle-release-builder.mjs';

const CANONICAL = 'https://github.com/iteathen/DevBridge.git';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

async function repositoryFixture(root) {
  const repository = path.join(root, 'repository');
  await mkdir(path.join(repository, 'src'), { recursive: true });
  await writeFile(path.join(repository, '.gitattributes'), '* text eol=lf\n');
  await writeFile(path.join(repository, 'package.json'), '{"name":"devbridge","version":"0.1.0"}\n');
  await writeFile(path.join(repository, 'src', 'cli.js'), 'export const fixture = true;\n');
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  git(repository, ['config', 'user.name', 'Source Release Fixture']);
  git(repository, ['remote', 'add', 'origin', CANONICAL]);
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '-m', 'fixture']);
  return Object.freeze({
    repository,
    head: git(repository, ['rev-parse', 'HEAD']).toLowerCase(),
    tree: git(repository, ['rev-parse', 'HEAD^{tree}']).toLowerCase(),
  });
}

function keyFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return Object.freeze({
    privateKeyBytes: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    publicKeyBytes: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })),
  });
}

test('release builder creates one signed chunked source object that the offline consumer materializes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-release-'));
  try {
    const source = await repositoryFixture(root);
    const keys = keyFixture();
    const releaseRoot = path.join(root, 'release');
    const built = await buildSourceBundleRelease({
      // Windows may preserve an 8.3 or case-variant spelling for the same real directory.
      repository: process.platform === 'win32' ? source.repository.toUpperCase() : source.repository,
      destination: releaseRoot,
      head: source.head,
      releaseId: 'stage8-source-1',
      sequence: 1,
      keyId: 'stage8-source-key',
      ...keys,
      chunkBytes: 257,
    });
    assert.equal(built.head, source.head);
    assert.equal(built.tree, source.tree);
    assert.ok(built.descriptor.objects[0].chunks.length > 1);
    assert.deepEqual((await readdir(path.join(releaseRoot, SOURCE_BUNDLE_RELEASE_OBJECT_DIRECTORY))).sort(), [...built.objectDigests].sort());
    assert.deepEqual((await readdir(releaseRoot)).sort(), [
      SOURCE_BUNDLE_RELEASE_MANIFEST_NAME,
      SOURCE_BUNDLE_RELEASE_OBJECT_DIRECTORY,
      SOURCE_BUNDLE_RELEASE_PUBLIC_KEY_NAME,
    ].sort());

    const materialization = new SourceBundleMaterialization({
      acquisition: new ImmutableObjectAcquisition({
        directory: path.join(root, 'cache'),
        sources: [
          new FilesystemImmutableObjectSource({ directory: path.join(releaseRoot, SOURCE_BUNDLE_RELEASE_OBJECT_DIRECTORY) }),
        ],
      }),
      checkout: new GitBundleCheckout(),
    });
    const prepared = await materialization.prepare({
      authority: {
        manifestBytes: await readFile(path.join(releaseRoot, SOURCE_BUNDLE_RELEASE_MANIFEST_NAME)),
        publicKeyBytes: await readFile(path.join(releaseRoot, SOURCE_BUNDLE_RELEASE_PUBLIC_KEY_NAME)),
        expectedManifestSha256: built.manifestSha256,
        expectedPublicKeySha256: built.publicKeySha256,
        expectedKeyId: built.keyId,
      },
      destination: path.join(root, 'checkout'),
    });
    assert.equal(prepared.head, source.head);
    assert.equal(prepared.tree, source.tree);
    assert.equal(git(prepared.root, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release builder rejects dirty, mismatched, or caller-owned state without residue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-release-fail-'));
  try {
    const source = await repositoryFixture(root);
    const keys = keyFixture();
    const foreignKeys = keyFixture();
    await assert.rejects(buildSourceBundleRelease({
      repository: source.repository,
      destination: path.join(root, 'key-mismatch'),
      head: source.head,
      releaseId: 'release-1',
      sequence: 1,
      keyId: 'key-1',
      privateKeyBytes: keys.privateKeyBytes,
      publicKeyBytes: foreignKeys.publicKeyBytes,
    }), /do not match/u);

    const existing = path.join(root, 'existing');
    await writeFile(existing, 'caller-owned');
    await assert.rejects(buildSourceBundleRelease({
      repository: source.repository,
      destination: existing,
      head: source.head,
      releaseId: 'release-1',
      sequence: 1,
      keyId: 'key-1',
      ...keys,
    }), /already exists/u);
    assert.equal(await readFile(existing, 'utf8'), 'caller-owned');

    await writeFile(path.join(source.repository, 'untracked.txt'), 'dirty');
    const dirty = path.join(root, 'dirty');
    await assert.rejects(buildSourceBundleRelease({
      repository: source.repository,
      destination: dirty,
      head: source.head,
      releaseId: 'release-1',
      sequence: 1,
      keyId: 'key-1',
      ...keys,
    }), /must be clean/u);
    await assert.rejects(readFile(dirty), /ENOENT/u);

    await rm(path.join(source.repository, 'untracked.txt'));
    const wrongHead = path.join(root, 'wrong-head');
    await assert.rejects(buildSourceBundleRelease({
      repository: source.repository,
      destination: wrongHead,
      head: 'f'.repeat(40),
      releaseId: 'release-1',
      sequence: 1,
      keyId: 'key-1',
      ...keys,
    }), /does not match repository HEAD/u);
    await assert.rejects(readFile(wrongHead), /ENOENT/u);

    git(source.repository, ['remote', 'set-url', 'origin', 'https://example.invalid/foreign.git']);
    const foreign = path.join(root, 'foreign');
    await assert.rejects(buildSourceBundleRelease({
      repository: source.repository,
      destination: foreign,
      head: source.head,
      releaseId: 'release-1',
      sequence: 1,
      keyId: 'key-1',
      ...keys,
    }), /origin is not canonical/u);
    await assert.rejects(readFile(foreign), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release CLI requires explicit local authority and reports only non-secret exact evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-release-cli-'));
  try {
    const source = await repositoryFixture(root);
    const keys = keyFixture();
    const privateKey = path.join(root, 'private.pem');
    const publicKey = path.join(root, 'public.pem');
    const destination = path.join(root, 'release');
    await writeFile(privateKey, keys.privateKeyBytes, { mode: 0o600 });
    await writeFile(publicKey, keys.publicKeyBytes, { mode: 0o600 });
    const stdout = execFileSync(process.execPath, [
      path.resolve('scripts/build-source-bundle-release.mjs'),
      '--repository', source.repository,
      '--destination', destination,
      '--head', source.head,
      '--release-id', 'stage8-source-cli-1',
      '--sequence', '1',
      '--key-id', 'stage8-source-key',
      '--private-key', privateKey,
      '--public-key', publicKey,
      '--chunk-bytes', '1024',
    ], { cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true });
    const result = JSON.parse(stdout);
    assert.equal(result.head, source.head);
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.equal(stdout.includes(keys.privateKeyBytes.toString('base64')), false);
    assert.equal(await readFile(path.join(destination, SOURCE_BUNDLE_RELEASE_PUBLIC_KEY_NAME), 'utf8'), keys.publicKeyBytes.toString('utf8'));

    assert.throws(() => execFileSync(process.execPath, [
      path.resolve('scripts/build-source-bundle-release.mjs'), '--unknown', 'value',
    ], { cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true, stdio: 'pipe' }), /Command failed/u);

    const linkedPrivate = path.join(root, 'linked-private.pem');
    await link(privateKey, linkedPrivate);
    assert.throws(() => execFileSync(process.execPath, [
      path.resolve('scripts/build-source-bundle-release.mjs'),
      '--repository', source.repository,
      '--destination', path.join(root, 'linked-release'),
      '--head', source.head,
      '--release-id', 'stage8-source-cli-2',
      '--sequence', '2',
      '--key-id', 'stage8-source-key',
      '--private-key', linkedPrivate,
      '--public-key', publicKey,
    ], { cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true, stdio: 'pipe' }), /Command failed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release builder rejects forged producer evidence and removes only its new destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-source-release-forged-'));
  try {
    const keys = keyFixture();
    const destination = path.join(root, 'release');
    await assert.rejects(buildSourceBundleRelease({
      repository: root,
      destination,
      head: 'a'.repeat(40),
      releaseId: 'release-1',
      sequence: 1,
      keyId: 'key-1',
      ...keys,
      bundleProducer: {
        async create({ destination: bundle }) {
          await writeFile(bundle, 'forged');
          return { head: 'a'.repeat(40), tree: 'not-a-tree', location: bundle };
        },
      },
    }), /producer evidence/u);
    await assert.rejects(readFile(destination), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source release modules retain release-only LEGO ownership', async () => {
  const files = await Promise.all([
    readFile(new URL('../src/release/git-source-bundle-producer.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/release/source-bundle-release-builder.mjs', import.meta.url), 'utf8'),
  ]);
  for (const source of files) {
    for (const forbidden of ['snapshot.ubuntu.com', 'Hyper-V', 'libvirt', 'setup --construct', 'prepareRuntimeCandidate', 'ExactCheckoutRunnerProvider']) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  }
  assert.equal(files[0].includes('privateKey'), false);
  assert.equal(files[1].includes('baseUrl'), false);
  assert.equal(files[1].includes('fetchImpl'), false);
});
