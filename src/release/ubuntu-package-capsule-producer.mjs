import { rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeUbuntuAptTransactionSolution } from './ubuntu-apt-transaction-solver.mjs';
import { captureUbuntuPackageCapsule } from './ubuntu-package-capsule-capture.mjs';
import { buildUbuntuPackageCapsuleRelease } from './ubuntu-package-capsule-release-builder.mjs';
import { verifyUbuntuCapsuleSolverInputPreparation } from './ubuntu-capsule-solver-input-preparer.mjs';

export const UBUNTU_PACKAGE_CAPSULE_PRODUCTION_PROTOCOL = 'devbridge/ubuntu-package-capsule-production-v1';

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return path.resolve(value);
}

function requireSeparateRoots(left, right) {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  if (!leftToRight || (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight))
      || (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft))) {
    fail('Ubuntu capsule capture and release destinations must be separate non-nested roots');
  }
}

function port(value, method, name) {
  if (!value || typeof value !== 'object' || typeof value[method] !== 'function') {
    throw new TypeError(`${name} port is invalid`);
  }
  return value;
}

function sameSolverRequest(left, right) {
  const paths = [
    'workspace', 'configurationFile', 'statusFile', 'sourcesListFile', 'sourcePartsDirectory', 'listsDirectory',
  ];
  return paths.every((name) => path.resolve(left?.[name] ?? '') === path.resolve(right?.[name] ?? ''))
    && left?.snapshot === right?.snapshot && left?.architecture === right?.architecture
    && Array.isArray(left?.requestedPackages) && Array.isArray(right?.requestedPackages)
    && left.requestedPackages.length === right.requestedPackages.length
    && left.requestedPackages.every((name, index) => name === right.requestedPackages[index]);
}

export class UbuntuPackageCapsuleProducer {
  constructor(raw = {}) {
    const value = exactObject(raw, new Set([
      'solver', 'archiveSource', 'inReleaseVerifier', 'capture', 'seal', 'verifyPreparation',
    ]), 'Ubuntu package-capsule producer options');
    this.solver = port(value.solver, 'solve', 'Ubuntu package-capsule solver');
    this.archiveSource = port(value.archiveSource, 'read', 'Ubuntu package-capsule archive source');
    this.inReleaseVerifier = port(value.inReleaseVerifier, 'verify', 'Ubuntu package-capsule InRelease verifier');
    this.capture = value.capture ?? captureUbuntuPackageCapsule;
    this.seal = value.seal ?? buildUbuntuPackageCapsuleRelease;
    this.verifyPreparation = value.verifyPreparation ?? verifyUbuntuCapsuleSolverInputPreparation;
    if (typeof this.capture !== 'function') throw new TypeError('Ubuntu package-capsule capture port is invalid');
    if (typeof this.seal !== 'function') throw new TypeError('Ubuntu package-capsule sealer port is invalid');
    if (typeof this.verifyPreparation !== 'function') throw new TypeError('Ubuntu solver-input preparation verifier port is invalid');
  }

  async produce(raw = {}) {
    const request = exactObject(raw, new Set([
      'policy', 'solverRequest', 'captureDestination', 'releaseDestination',
      'preparation', 'keyId', 'privateKeyBytes', 'publicKeyBytes', 'chunkBytes', 'signal',
    ]), 'Ubuntu package-capsule production request');
    const policy = exactObject(request.policy, new Set([
      'distribution', 'release', 'codename', 'architecture', 'snapshot', 'baseMediaSha256',
      'releaseId', 'sequence', 'upstreamKeyFingerprint',
    ]), 'Ubuntu package-capsule production policy');
    const solverRequest = exactObject(request.solverRequest, new Set([
      'workspace', 'configurationFile', 'statusFile', 'sourcesListFile', 'sourcePartsDirectory',
      'listsDirectory', 'snapshot', 'architecture', 'requestedPackages',
    ]), 'Ubuntu package-capsule production solver request');
    if (policy.snapshot !== solverRequest.snapshot || policy.architecture !== solverRequest.architecture) {
      fail('Ubuntu package-capsule production policy does not match its solver input');
    }
    if (request.signal != null && typeof request.signal !== 'object') {
      throw new TypeError('Ubuntu package-capsule production signal is invalid');
    }
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new Error('Ubuntu package-capsule production was interrupted');
    }
    const captureDestination = absolutePath(request.captureDestination, 'Ubuntu capsule capture destination');
    const releaseDestination = absolutePath(request.releaseDestination, 'Ubuntu capsule release destination');
    requireSeparateRoots(captureDestination, releaseDestination);
    const admittedSolverRequest = await this.verifyPreparation(request.preparation, policy);
    if (!sameSolverRequest(admittedSolverRequest, solverRequest)) {
      fail('Ubuntu package-capsule production solver input does not match its preparation');
    }

    let ownedCaptureRoot = null;
    try {
      const solution = normalizeUbuntuAptTransactionSolution(
        await this.solver.solve(Object.freeze({ ...admittedSolverRequest, signal: request.signal ?? null })),
      );
      const captured = await this.capture(Object.freeze({
        policy,
        solution,
        destination: captureDestination,
        readArchive: (entry) => this.archiveSource.read(entry),
        verifyInRelease: (entry) => this.inReleaseVerifier.verify(entry),
        signal: request.signal ?? null,
      }));
      if (path.resolve(captured?.root ?? '') !== captureDestination) {
        fail('Ubuntu package-capsule capture returned mismatched ownership evidence');
      }
      ownedCaptureRoot = captureDestination;
      const sealed = await this.seal(Object.freeze({
        capture: captured.capture,
        artifacts: captured.artifacts,
        destination: releaseDestination,
        keyId: request.keyId,
        privateKeyBytes: request.privateKeyBytes,
        publicKeyBytes: request.publicKeyBytes,
        verifyInRelease: (entry) => this.inReleaseVerifier.verify(entry),
        ...(request.chunkBytes == null ? {} : { chunkBytes: request.chunkBytes }),
        signal: request.signal ?? null,
      }));
      if (path.resolve(sealed?.root ?? '') !== releaseDestination
          || sealed.snapshot !== policy.snapshot || sealed.releaseId !== policy.releaseId
          || sealed.sequence !== policy.sequence) {
        fail('Ubuntu package-capsule sealer returned mismatched release evidence');
      }
      return Object.freeze({
        protocol: UBUNTU_PACKAGE_CAPSULE_PRODUCTION_PROTOCOL,
        release: sealed,
        solution: Object.freeze({
          protocol: solution.protocol,
          snapshot: solution.snapshot,
          architecture: solution.architecture,
          selectedPackages: solution.selectedPackages.length,
          basePackageStateSha256: solution.transaction.basePackageStateSha256,
          resultPackageStateSha256: solution.transaction.resultPackageStateSha256,
        }),
        capture: Object.freeze({ artifactCount: captured.artifactCount, bytes: captured.bytes }),
      });
    } finally {
      if (ownedCaptureRoot != null) await rm(ownedCaptureRoot, { recursive: true, force: true });
    }
  }
}
