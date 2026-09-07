#!/usr/bin/env node
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { sameFilesystemIdentity, sameObservedFilesystemIdentity } from '../src/runtime/local-filesystem-identity.js';
import { GpgvInReleaseVerifier } from '../src/release/gpgv-inrelease-verifier.mjs';
import { UbuntuAptTransactionSolver } from '../src/release/ubuntu-apt-transaction-solver.mjs';
import { UbuntuPackageCapsuleProducer } from '../src/release/ubuntu-package-capsule-producer.mjs';
import { UbuntuSnapshotArchiveHttpsSource } from '../src/release/ubuntu-snapshot-archive-https-source.mjs';

const MAX_KEY_BYTES = 16 * 1024;
const MAX_RECIPE_BYTES = 4 * 1024 * 1024;
const OPTIONS = new Set([
  '--recipe', '--capture-destination', '--destination', '--apt-get', '--archive-base-url',
  '--archive-duration-ms', '--gpgv', '--keyring', '--key-id', '--private-key', '--public-key',
  '--chunk-bytes',
]);

function parsePositive(value, name) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) throw new TypeError(`${name} is invalid`);
  const selected = Number(value);
  if (!Number.isSafeInteger(selected)) throw new TypeError(`${name} is invalid`);
  return selected;
}

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new TypeError('Ubuntu capsule production arguments require option/value pairs');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!OPTIONS.has(name)) throw new TypeError(`Ubuntu capsule production option ${name} is unsupported`);
    if (values.has(name)) throw new TypeError(`Ubuntu capsule production option ${name} is duplicated`);
    values.set(name, value);
  }
  for (const name of OPTIONS) {
    if (name === '--chunk-bytes') continue;
    if (!values.has(name)) throw new TypeError(`Ubuntu capsule production option ${name} is required`);
  }
  for (const name of [
    '--recipe', '--capture-destination', '--destination', '--apt-get', '--gpgv', '--keyring',
    '--private-key', '--public-key',
  ]) {
    if (!path.isAbsolute(values.get(name)) || values.get(name).includes('\0')) {
      throw new TypeError(`Ubuntu capsule production option ${name} must be an absolute local path`);
    }
  }
  return Object.freeze({
    recipe: values.get('--recipe'),
    captureDestination: values.get('--capture-destination'),
    releaseDestination: values.get('--destination'),
    aptGet: values.get('--apt-get'),
    archiveBaseUrl: values.get('--archive-base-url'),
    archiveDurationMs: parsePositive(values.get('--archive-duration-ms'), '--archive-duration-ms'),
    gpgv: values.get('--gpgv'),
    keyring: values.get('--keyring'),
    keyId: values.get('--key-id'),
    privateKey: values.get('--private-key'),
    publicKey: values.get('--public-key'),
    chunkBytes: values.has('--chunk-bytes') ? parsePositive(values.get('--chunk-bytes'), '--chunk-bytes') : undefined,
  });
}

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readBounded(location, name, maximum) {
  const selected = path.resolve(location);
  if (!await sameFilesystemIdentity(selected, await realpath(selected))) throw new Error(`${name} must use a direct nonsymbolic path`);
  const before = await lstat(selected, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)) {
    throw new Error(`${name} must be one bounded unlinked regular file`);
  }
  const handle = await open(selected, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!sameFile(before, held)) throw new Error(`${name} changed while opening`);
    const bytes = await handle.readFile();
    const after = await lstat(selected, { bigint: true });
    if (bytes.length !== Number(before.size) || !sameFile(held, after)) throw new Error(`${name} changed while reading`);
    return bytes;
  } finally { await handle.close(); }
}

const args = parseArgs(process.argv.slice(2));
const [recipeBytes, privateKeyBytes, publicKeyBytes] = await Promise.all([
  readBounded(args.recipe, 'Ubuntu capsule production recipe', MAX_RECIPE_BYTES),
  readBounded(args.privateKey, 'Ubuntu capsule private key', MAX_KEY_BYTES),
  readBounded(args.publicKey, 'Ubuntu capsule public key', MAX_KEY_BYTES),
]);
let recipe;
try { recipe = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(recipeBytes)); }
catch { throw new Error('Ubuntu capsule production recipe is not valid JSON'); }
if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)
    || Object.keys(recipe).some((key) => !['policy', 'solverRequest', 'preparation'].includes(key))
    || !recipe.policy || !recipe.solverRequest || !recipe.preparation) {
  throw new TypeError('Ubuntu capsule production recipe has unsupported fields');
}

const producer = new UbuntuPackageCapsuleProducer({
  solver: new UbuntuAptTransactionSolver({ executable: args.aptGet }),
  archiveSource: new UbuntuSnapshotArchiveHttpsSource({
    baseUrl: args.archiveBaseUrl,
    snapshot: recipe.policy.snapshot,
    maxDurationMs: args.archiveDurationMs,
  }),
  inReleaseVerifier: new GpgvInReleaseVerifier({ executable: args.gpgv, keyring: args.keyring }),
});
const controller = new AbortController();
const interrupt = (name) => () => controller.abort(new Error(`Ubuntu capsule production interrupted by ${name}`));
const onInterrupt = interrupt('SIGINT');
const onTerminate = interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
const request = {
  policy: recipe.policy,
  solverRequest: recipe.solverRequest,
  preparation: recipe.preparation,
  captureDestination: args.captureDestination,
  releaseDestination: args.releaseDestination,
  keyId: args.keyId,
  privateKeyBytes,
  publicKeyBytes,
  signal: controller.signal,
};
if (args.chunkBytes != null) request.chunkBytes = args.chunkBytes;
try {
  const result = await producer.produce(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
