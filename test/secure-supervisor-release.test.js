import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { superviseDaemon } from '../patch-poller.mjs';
import {
  RELEASE_MANIFEST_PROTOCOL,
  RELEASE_REPOSITORY,
  releaseSubjectPayload,
} from '../src/bootstrap/release-integrity.mjs';

const runtimeA = {
  head: 'a'.repeat(40),
  ref: 'main',
  cliPath: '/managed/runtime/src/cli.js',
  runtimeDir: '/managed/runtime',
  version: '0.1.0',
};
const artifactB = 'd'.repeat(64);
const runtimeB = {
  head: 'b'.repeat(40),
  ref: 'main',
  cliPath: `/managed/runtime-candidates/${'b'.repeat(40)}/src/cli.js`,
  runtimeDir: `/managed/runtime-candidates/${'b'.repeat(40)}`,
  version: '0.1.0',
  artifactSha256: artifactB,
  releaseIntegrity: {
    mode: 'production',
    verified: true,
    immutableRelease: true,
    artifactSha256: artifactB,
    manifestSha256: 'e'.repeat(64),
    keyId: 'release-key',
  },
  validation: {
    sandbox: {
      provider: 'bubblewrap',
      verified: true,
      verification: 'boundary-probe',
      filesystem: 'project-and-run-scratch-write-only',
      network: 'denied',
    },
  },
};

function timer(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms))); }

async function signedReleaseFiles(head = runtimeB.head) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-secure-supervisor-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const release = { repository: RELEASE_REPOSITORY, head, artifactSha256: artifactB, version: '0.1.0' };
  const value = sign(null, releaseSubjectPayload(release), privateKey).toString('base64');
  const releaseManifest = path.join(root, 'release.json');
  const releasePublicKey = path.join(root, 'release.pub.pem');
  await writeFile(releasePublicKey, publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(releaseManifest, `${JSON.stringify({
    protocol: RELEASE_MANIFEST_PROTOCOL,
    release,
    signature: { algorithm: 'ed25519', keyId: 'release-key', value },
  })}\n`);
  return { releaseManifest, releasePublicKey };
}

function productionArgs(files) {
  return {
    channel: 'stable',
    update: true,
    releaseMode: 'production',
    ...files,
  };
}

const paths = {
  home: '/managed',
  runtime: '/managed/runtime',
  runtimeCandidates: '/managed/runtime-candidates',
  activationStateFile: '/managed/runtime-activation.json',
  config: '/operator/config.json',
};

test('production supervisor ignores mutable stable movement that is not the signed release head', async () => {
  const files = await signedReleaseFiles();
  const child = new EventEmitter();
  child.pid = 900;
  let candidatePrepares = 0;
  let stops = 0;
  const result = await superviseDaemon(productionArgs(files), paths, runtimeA, {
    spawnImpl: () => {
      setTimeout(() => child.emit('exit', 0, null), 15);
      return child;
    },
    maxIterations: 1,
    takeover: false,
    updateIntervalMs: 1,
    updateCheckDelayFn: timer,
    remoteHeadFn: () => 'c'.repeat(40),
    resolveChannelRefFn: () => 'main',
    candidatePrepareFn: async () => { candidatePrepares += 1; return runtimeB; },
    runPollerCliFn: (command) => { if (command === 'stop') stops += 1; return 0; },
    delayFn: timer,
  });
  assert.equal(result, 0);
  assert.equal(candidatePrepares, 0);
  assert.equal(stops, 0);
});

test('production supervisor validates only the signed head and journals exact artifact/sandbox evidence', async () => {
  const files = await signedReleaseFiles();
  const records = [];
  let starts = 0;
  let current = null;
  const spawnImpl = () => {
    starts += 1;
    const child = new EventEmitter();
    child.pid = 950 + starts;
    current = child;
    if (starts === 2) setTimeout(() => child.emit('exit', 0, null), 15);
    return child;
  };
  const result = await superviseDaemon(productionArgs(files), paths, runtimeA, {
    spawnImpl,
    maxIterations: 2,
    takeover: false,
    updateIntervalMs: 1,
    healthWindowMs: 1,
    updateCheckDelayFn: timer,
    healthCheckDelayFn: timer,
    delayFn: timer,
    remoteHeadFn: () => runtimeB.head,
    resolveChannelRefFn: () => 'main',
    candidatePrepareFn: async (_args, _paths, { desiredHead }) => {
      assert.equal(desiredHead, runtimeB.head);
      return runtimeB;
    },
    runPollerCliFn: (command, _paths, runtime) => {
      if (command === 'stop') setTimeout(() => current.emit('exit', 0, null), 0);
      if (command === 'doctor') assert.equal(runtime.head, runtimeB.head);
      return 0;
    },
    recordActivationFn: (_paths, record) => { records.push(record); },
  });
  assert.equal(result, 0);
  const validated = records.find((record) => record.state === 'candidate-validated');
  assert.equal(validated.candidate.head, runtimeB.head);
  assert.equal(validated.candidate.artifactSha256, artifactB);
  assert.equal(validated.candidate.releaseIntegrity.mode, 'production');
  assert.equal(validated.candidate.releaseIntegrity.verified, true);
  assert.equal(validated.candidate.validationSandbox.provider, 'bubblewrap');
  assert.equal(validated.candidate.validationSandbox.network, 'denied');
  const healthy = records.find((record) => record.state === 'healthy');
  assert.equal(healthy.current.head, runtimeB.head);
  assert.equal(healthy.current.artifactSha256, artifactB);
});
