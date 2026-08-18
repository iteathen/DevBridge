import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  candidateTreeSha256,
  validateRuntimeCandidate,
  verifyProductionReleaseManifest,
} from '../src/bootstrap/transactional-bootstrap.mjs';

const RELEASE_PROTOCOL = 'patch-poller/release-manifest-v1';
const REPOSITORY = 'iteathen/PATCH-POLLER';

function releasePayload(manifest) {
  return JSON.stringify({
    protocol: RELEASE_PROTOCOL,
    repository: manifest.repository,
    commit: manifest.commit,
    treeSha256: manifest.treeSha256,
    createdAt: manifest.createdAt,
  });
}

test('production release verification binds a trusted signature to exact candidate tree bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-release-security-'));
  try {
    const runtimeDir = path.join(root, 'runtime');
    await mkdir(path.join(runtimeDir, 'src'), { recursive: true });
    await writeFile(path.join(runtimeDir, 'src', 'main.js'), 'export const version = 1;\n');
    const head = 'a'.repeat(40);
    const treeSha256 = candidateTreeSha256(runtimeDir);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const manifest = {
      protocol: RELEASE_PROTOCOL,
      repository: REPOSITORY,
      commit: head,
      treeSha256,
      createdAt: '2026-08-18T20:00:00Z',
    };
    manifest.signature = sign(null, Buffer.from(releasePayload(manifest), 'utf8'), privateKey).toString('base64');
    const manifestFile = path.join(root, 'release.json');
    const publicKeyFile = path.join(root, 'release.pub.pem');
    await writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await writeFile(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }));
    const verified = verifyProductionReleaseManifest(
      { home: root },
      { head, runtimeDir },
      { PATCH_POLLER_RELEASE_MANIFEST_FILE: manifestFile, PATCH_POLLER_RELEASE_PUBLIC_KEY_FILE: publicKeyFile },
    );
    assert.equal(verified.mode, 'production');
    assert.equal(verified.manifest.treeSha256, treeSha256);

    await writeFile(path.join(runtimeDir, 'src', 'main.js'), 'export const version = 2;\n');
    assert.throws(() => verifyProductionReleaseManifest(
      { home: root },
      { head, runtimeDir },
      { PATCH_POLLER_RELEASE_MANIFEST_FILE: manifestFile, PATCH_POLLER_RELEASE_PUBLIC_KEY_FILE: publicKeyFile },
    ), /tree digest mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production release verification fails closed without local trusted manifest/key material', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-release-missing-'));
  try {
    const runtimeDir = path.join(root, 'runtime');
    await mkdir(runtimeDir);
    assert.throws(() => verifyProductionReleaseManifest({ home: root }, { head: 'a'.repeat(40), runtimeDir }, {}), /require absolute/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate-controlled validation cannot start when sandbox enforcement is unverified', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-candidate-no-sandbox-'));
  try {
    const runtimeDir = path.join(root, 'runtime');
    await mkdir(runtimeDir);
    let runnerCalled = false;
    await assert.rejects(validateRuntimeCandidate(
      { home: root },
      { head: 'b'.repeat(40), runtimeDir },
      () => { runnerCalled = true; return { status: 0, stdout: '', stderr: '' }; },
      { sandboxProvider: {
        verify: async () => ({ provider: 'fixture', verified: false, verification: 'failed', reason: 'fixture unavailable' }),
      } },
    ), /requires verified sandbox containment/u);
    assert.equal(runnerCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate validation requests read-only project, bounded scratch, denied network, and scrubbed credentials for every candidate-controlled command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-candidate-sandbox-'));
  const requests = [];
  try {
    const runtimeDir = path.join(root, 'runtime');
    await mkdir(path.join(runtimeDir, 'src', 'bootstrap'), { recursive: true });
    await mkdir(path.join(runtimeDir, 'src'), { recursive: true });
    await writeFile(path.join(runtimeDir, 'fixture.txt'), 'immutable candidate bytes\n');
    const provider = {
      verify: async () => ({ provider: 'fixture', configured: true, verified: true, verification: 'boundary-probe-passed' }),
      prepareSpawn: async (request) => {
        requests.push(structuredClone(request));
        return { executable: request.executable, args: request.args, cwd: request.cwd, environment: request.environment, provider: 'fixture' };
      },
    };
    const runner = (_executable, _args, options) => {
      assert.equal(options.shell, false);
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    const before = candidateTreeSha256(runtimeDir);
    const validation = await validateRuntimeCandidate(
      { home: root },
      { head: 'c'.repeat(40), runtimeDir },
      runner,
      {
        environment: {
          PATH: process.env.PATH ?? '',
          PATCH_POLLER_GITHUB_TOKEN: 'control-secret',
          HOME: path.join(root, 'control-home'),
          USERPROFILE: path.join(root, 'control-home'),
        },
        sandboxProvider: provider,
      },
    );
    assert.equal(validation.artifactSha256, before);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.sandbox.projectRoot, runtimeDir);
      assert.equal(request.sandbox.projectWritable, false);
      assert.equal(request.sandbox.network, 'deny');
      assert.equal(request.sandbox.writableRoots.length, 1);
      assert.equal(request.sandbox.writableRoots[0].startsWith(path.join(root, 'candidate-validation')), true);
      assert.equal(Object.hasOwn(request.environment, 'PATCH_POLLER_GITHUB_TOKEN'), false);
      assert.notEqual(request.environment.HOME, path.join(root, 'control-home'));
      assert.equal(request.environment.HOME.startsWith(path.join(root, 'candidate-validation')), true);
    }
    assert.equal(await readFile(path.join(runtimeDir, 'fixture.txt'), 'utf8'), 'immutable candidate bytes\n');
    assert.equal(candidateTreeSha256(runtimeDir), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
