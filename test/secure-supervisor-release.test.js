import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { superviseDaemon } from '../src/bootstrap/secure-bootstrap.mjs';
import {
  RELEASE_MANIFEST_PROTOCOL,
  RELEASE_REPOSITORY,
  releaseSubjectPayload,
} from '../src/bootstrap/release-integrity.mjs';

const artifactA = 'c'.repeat(64);
const artifactB = 'd'.repeat(64);
const runtimeA = {
  head: 'a'.repeat(40),
  ref: 'main',
  cliPath: '/managed/runtime/src/cli.js',
  runtimeDir: '/managed/runtime',
  version: '0.1.0',
  artifactSha256: artifactA,
  releaseIntegrity: {
    mode: 'production',
    verified: true,
    immutableRelease: true,
    artifactSha256: artifactA,
    manifestSha256: 'f'.repeat(64),
    keyId: 'previous-release-key',
  },
};
const runtimeB = {
  ...runtimeA,
  head: 'b'.repeat(40),
  cliPath: `/managed/runtime-candidates/${'b'.repeat(40)}/src/cli.js`,
  runtimeDir: `/managed/runtime-candidates/${'b'.repeat(40)}`,
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
    execution: {
      identity: 'fixture-execution',
      ready: true,
      artifactPreserved: true,
    },
  },
};

function timer(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms))); }

function exactFakeDigest(runtimeDir) {
  if (runtimeDir === runtimeA.runtimeDir) return { sha256: artifactA };
  if (runtimeDir === runtimeB.runtimeDir) return { sha256: artifactB };
  throw new Error(`unexpected fake runtime digest path ${runtimeDir}`);
}

function transitionControls(events = null) {
  const owner = Object.freeze({ pid: 9001, createdAt: '2026-08-21T18:00:00.000Z' });
  return {
    pauseRuntimeOwnerFn: async () => {
      events?.push('pause');
      return owner;
    },
    resumeRuntimeOwnerFn: async (_control, expected) => {
      assert.deepEqual(expected, owner);
      events?.push('resume');
      return { ...owner, resumed: true };
    },
  };
}

async function signedReleaseFiles(head = runtimeB.head) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-secure-supervisor-'));
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
    artifactDigestSyncFn: exactFakeDigest,
    maxIterations: 1,
    stopExisting: false,
    updateIntervalMs: 1,
    updateCheckDelayFn: timer,
    remoteHeadFn: () => 'c'.repeat(40),
    resolveChannelRefFn: () => 'main',
    candidatePrepareFn: async () => { candidatePrepares += 1; return runtimeB; },
    runDevBridgeCliFn: (command) => { if (command === 'stop') stops += 1; return 0; },
    delayFn: timer,
  });
  assert.equal(result, 0);
  assert.equal(candidatePrepares, 0);
  assert.equal(stops, 0);
});

test('production supervisor pauses accepted owner before validation and launches supervised children headlessly', async () => {
  const files = await signedReleaseFiles();
  const records = [];
  const transitionEvents = [];
  let starts = 0;
  let current = null;
  const spawnImpl = (_executable, _argv, spawnOptions) => {
    assert.equal(spawnOptions.windowsHide, true);
    starts += 1;
    const child = new EventEmitter();
    child.pid = 950 + starts;
    current = child;
    if (starts === 2) setTimeout(() => child.emit('exit', 0, null), 15);
    return child;
  };
  const result = await superviseDaemon(productionArgs(files), paths, runtimeA, {
    spawnImpl,
    artifactDigestSyncFn: exactFakeDigest,
    maxIterations: 2,
    stopExisting: false,
    updateIntervalMs: 1,
    healthWindowMs: 1,
    updateCheckDelayFn: timer,
    healthCheckDelayFn: timer,
    delayFn: timer,
    remoteHeadFn: () => runtimeB.head,
    resolveChannelRefFn: () => 'main',
    candidatePrepareFn: async (_args, _paths, { desiredHead }) => {
      transitionEvents.push('validate');
      assert.equal(desiredHead, runtimeB.head);
      return runtimeB;
    },
    runDevBridgeCliFn: (command, _paths, runtime) => {
      if (command === 'stop') setTimeout(() => current.emit('exit', 0, null), 0);
      if (command === 'doctor') assert.equal(runtime.head, runtimeB.head);
      return 0;
    },
    recordActivationFn: (_paths, record) => { records.push(record); },
    ...transitionControls(transitionEvents),
  });
  assert.equal(result, 0);
  assert.deepEqual(transitionEvents.slice(0, 2), ['pause', 'validate']);
  const validated = records.find((record) => record.state === 'candidate-validated');
  assert.equal(validated.candidate.head, runtimeB.head);
  assert.equal(validated.candidate.artifactSha256, artifactB);
  assert.equal(validated.candidate.releaseIntegrity.mode, 'production');
  assert.equal(validated.candidate.releaseIntegrity.verified, true);
  assert.equal(validated.candidate.validationExecution.identity, 'fixture-execution');
  assert.equal(validated.candidate.validationExecution.artifactPreserved, true);
  const healthy = records.find((record) => record.state === 'healthy');
  assert.equal(healthy.current.head, runtimeB.head);
  assert.equal(healthy.current.artifactSha256, artifactB);
});

test('rejected candidate validation proves the accepted runtime owner resumed and never requests replacement', async () => {
  const files = await signedReleaseFiles();
  const events = [];
  const child = new EventEmitter();
  child.pid = 990;
  const result = await superviseDaemon(productionArgs(files), paths, runtimeA, {
    spawnImpl: () => {
      setTimeout(() => child.emit('exit', 0, null), 20);
      return child;
    },
    artifactDigestSyncFn: exactFakeDigest,
    maxIterations: 1,
    stopExisting: false,
    updateIntervalMs: 1,
    updateCheckDelayFn: timer,
    remoteHeadFn: () => runtimeB.head,
    resolveChannelRefFn: () => 'main',
    candidatePrepareFn: async () => {
      events.push('validate');
      throw new Error('candidate rejected');
    },
    runDevBridgeCliFn: (command) => { events.push(command); return 0; },
    recordActivationFn: () => {},
    delayFn: timer,
    ...transitionControls(events),
  });
  assert.equal(result, 0);
  assert.deepEqual(events.slice(0, 3), ['pause', 'validate', 'resume']);
  assert.equal(events.includes('stop'), false);
});

test('unprovable resume stops the uncertain accepted owner and exits supervisor recovery after journaling failure', async () => {
  const files = await signedReleaseFiles();
  const events = [];
  const records = [];
  const child = new EventEmitter();
  child.pid = 995;
  const result = superviseDaemon(productionArgs(files), paths, runtimeA, {
    spawnImpl: () => child,
    artifactDigestSyncFn: exactFakeDigest,
    maxIterations: 1,
    stopExisting: false,
    updateIntervalMs: 1,
    updateCheckDelayFn: timer,
    remoteHeadFn: () => runtimeB.head,
    resolveChannelRefFn: () => 'main',
    candidatePrepareFn: async () => {
      events.push('validate');
      throw new Error('candidate rejected');
    },
    pauseRuntimeOwnerFn: async () => {
      events.push('pause');
      return { pid: 9001, createdAt: '2026-08-21T18:00:00.000Z' };
    },
    resumeRuntimeOwnerFn: async () => {
      events.push('resume');
      throw new Error('resume ownership changed');
    },
    stopRuntimeOwnerFn: async () => {
      events.push('recover-stop');
      return { stopped: true };
    },
    recordActivationFn: (_paths, record) => { records.push(record); },
    delayFn: timer,
  });
  await assert.rejects(result, /supervisor recovery is required/u);
  assert.deepEqual(events, ['pause', 'validate', 'resume', 'recover-stop']);
  assert.ok(records.some((record) => record.state === 'candidate-failed'));
  assert.equal(records.some((record) => record.state === 'candidate-validated'), false);
});

test('production supervisor refuses a candidate whose bytes change after validation and before daemon spawn', async () => {
  const files = await signedReleaseFiles();
  let starts = 0;
  let current = null;
  let candidateDigestChecks = 0;
  const spawnImpl = () => {
    starts += 1;
    const child = new EventEmitter();
    child.pid = 1000 + starts;
    current = child;
    return child;
  };
  const result = superviseDaemon(productionArgs(files), paths, runtimeA, {
    spawnImpl,
    artifactDigestSyncFn: (runtimeDir) => {
      if (runtimeDir === runtimeA.runtimeDir) return { sha256: artifactA };
      if (runtimeDir === runtimeB.runtimeDir) {
        candidateDigestChecks += 1;
        return { sha256: '0'.repeat(64) };
      }
      throw new Error('unexpected runtime path');
    },
    maxIterations: 2,
    stopExisting: false,
    updateIntervalMs: 1,
    updateCheckDelayFn: timer,
    remoteHeadFn: () => runtimeB.head,
    resolveChannelRefFn: () => 'main',
    candidatePrepareFn: async () => runtimeB,
    runDevBridgeCliFn: (command) => {
      if (command === 'stop') setTimeout(() => current.emit('exit', 0, null), 0);
      return 0;
    },
    recordActivationFn: () => {},
    delayFn: timer,
    ...transitionControls(),
  });
  await assert.rejects(result, /runtime artifact changed after validation before activation/u);
  assert.equal(starts, 1, 'mutated candidate daemon must never start');
  assert.equal(candidateDigestChecks, 1);
});
