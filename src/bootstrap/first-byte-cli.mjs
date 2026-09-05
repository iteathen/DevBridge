#!/usr/bin/env node
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { FirstByteBootstrapExecution } from './first-byte-execution.mjs';
import { ImmutableObjectAcquisition } from '../runtime/immutable-object-acquisition.js';
import { FilesystemImmutableObjectSource } from '../runtime/immutable-object-sources/filesystem.js';
import { HttpsImmutableObjectSource } from '../runtime/immutable-object-sources/https.js';
import { sameObservedFilesystemIdentity } from '../runtime/local-filesystem-identity.js';

const DIGEST = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[A-Za-z0-9_.:-]+$/u;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 16 * 1024;

function fail(message) { throw new Error(message); }

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) fail(`${flag} requires a value`);
  return value;
}

function one(current, flag) {
  if (current != null) fail(`Only one ${flag} may be supplied.`);
}

function absolute(value, name) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) fail(`${name} must be an absolute path.`);
  return path.resolve(value);
}

function exactDigest(value, name) {
  const selected = String(value ?? '').toLowerCase();
  if (!DIGEST.test(selected)) fail(`${name} must be an exact SHA-256 digest.`);
  return selected;
}

export function parseFirstByteArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError('first-byte argv must be an array');
  const delimiter = argv.indexOf('--');
  const firstByteArguments = delimiter < 0 ? argv : argv.slice(0, delimiter);
  if (firstByteArguments.includes('--help') || firstByteArguments.includes('-h')) {
    if (argv.length !== 1) fail('First-byte help must be used alone.');
    return Object.freeze({
      help: true, manifest: null, publicKey: null, expectedManifestSha256: null,
      expectedPublicKeySha256: null, expectedKeyId: null, cache: null,
      sourceDurationMs: null, sources: Object.freeze([]), bootstrapArguments: Object.freeze([]),
    });
  }
  let manifest = null;
  let publicKey = null;
  let expectedManifestSha256 = null;
  let expectedPublicKeySha256 = null;
  let expectedKeyId = null;
  let cache = null;
  let sourceDurationMs = null;
  const sources = [];
  let bootstrapArguments = null;
  const valueFlags = new Set([
    '--manifest', '--public-key', '--manifest-sha256', '--public-key-sha256', '--key-id',
    '--cache', '--origin', '--offline', '--source-duration-ms',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') {
      bootstrapArguments = argv.slice(index + 1);
      break;
    }
    if (!valueFlags.has(flag)) fail(`Unsupported first-byte argument: ${flag}`);
    const selected = valueAfter(argv, index, flag);
    if (flag === '--manifest') { one(manifest, flag); manifest = absolute(selected, flag); }
    else if (flag === '--public-key') { one(publicKey, flag); publicKey = absolute(selected, flag); }
    else if (flag === '--manifest-sha256') { one(expectedManifestSha256, flag); expectedManifestSha256 = exactDigest(selected, flag); }
    else if (flag === '--public-key-sha256') { one(expectedPublicKeySha256, flag); expectedPublicKeySha256 = exactDigest(selected, flag); }
    else if (flag === '--key-id') {
      one(expectedKeyId, flag);
      if (selected.length > 128 || !KEY_ID.test(selected)) fail('--key-id is invalid.');
      expectedKeyId = selected;
    }
    else if (flag === '--cache') { one(cache, flag); cache = absolute(selected, flag); }
    else if (flag === '--origin') { sources.push(Object.freeze({ kind: 'https', value: selected })); }
    else if (flag === '--offline') { sources.push(Object.freeze({ kind: 'filesystem', value: absolute(selected, flag) })); }
    else if (flag === '--source-duration-ms') {
      one(sourceDurationMs, flag);
      if (!/^[1-9][0-9]*$/u.test(selected)) fail('First-byte source duration is invalid.');
      sourceDurationMs = Number(selected);
      if (!Number.isSafeInteger(sourceDurationMs) || sourceDurationMs < 1_000 || sourceDurationMs > MAX_DURATION_MS) {
        fail('First-byte source duration is invalid.');
      }
    }
    index += 1;
  }
  for (const [name, value] of Object.entries({ manifest, publicKey, expectedManifestSha256, expectedPublicKeySha256, expectedKeyId, cache })) {
    if (value == null) fail(`First-byte ${name} is required.`);
  }
  if (sources.length < 1 || sources.length > 16) fail('First-byte requires at least one source and at most sixteen sources.');
  const hasHttps = sources.some((source) => source.kind === 'https');
  if (hasHttps && sourceDurationMs == null) fail('--source-duration-ms is required with an HTTPS source.');
  if (!hasHttps && sourceDurationMs != null) fail('--source-duration-ms is only valid with HTTPS sources.');
  if (bootstrapArguments == null) fail('First-byte bootstrap arguments require the -- delimiter.');
  const sourceKeys = sources.map((source) => `${source.kind}:${source.value}`);
  if (new Set(sourceKeys).size !== sourceKeys.length) fail('First-byte sources must be unique.');
  return Object.freeze({
    help: false,
    manifest,
    publicKey,
    expectedManifestSha256,
    expectedPublicKeySha256,
    expectedKeyId,
    cache,
    sourceDurationMs,
    sources: Object.freeze(sources),
    bootstrapArguments: Object.freeze(bootstrapArguments),
  });
}

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readLocalAuthorityFile(location, name, maximum) {
  const before = await lstat(location, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)) {
    fail(`${name} must be one bounded real file.`);
  }
  const handle = await open(location, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || !sameFile(before, held)) fail(`${name} changed while opening.`);
    const bytes = await handle.readFile();
    const after = await lstat(location, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameFile(held, after)) fail(`${name} changed while reading.`);
    return bytes;
  } finally { await handle.close(); }
}

export async function runFirstByte(argv, { loadModule } = {}) {
  const options = parseFirstByteArguments(argv);
  if (options.help) return Object.freeze({ help: true, status: 0 });
  const [manifestBytes, publicKeyBytes] = await Promise.all([
    readLocalAuthorityFile(options.manifest, 'First-byte manifest', MAX_MANIFEST_BYTES),
    readLocalAuthorityFile(options.publicKey, 'First-byte public key', MAX_KEY_BYTES),
  ]);
  const sources = options.sources.map((source) => source.kind === 'https'
    ? new HttpsImmutableObjectSource({ baseUrl: source.value, maxDurationMs: options.sourceDurationMs })
    : new FilesystemImmutableObjectSource({ directory: source.value }));
  const acquisition = new ImmutableObjectAcquisition({ directory: options.cache, sources });
  const execution = new FirstByteBootstrapExecution({ acquisition, ...(loadModule == null ? {} : { loadModule }) });
  return execution.run({
    authority: {
      manifestBytes,
      publicKeyBytes,
      expectedManifestSha256: options.expectedManifestSha256,
      expectedPublicKeySha256: options.expectedPublicKeySha256,
      expectedKeyId: options.expectedKeyId,
    },
    argv: options.bootstrapArguments,
  });
}

export function firstByteHelp() {
  return `DevBridge signed first-byte loader\n\nUsage:\n  <trusted first-byte loader> --manifest <absolute-path> --public-key <absolute-path> --manifest-sha256 <digest> --public-key-sha256 <digest> --key-id <id> --cache <absolute-path> [--origin <https-object-base> | --offline <absolute-directory>]... [--source-duration-ms <milliseconds>] -- <bootstrap arguments>\n\nThe distribution command must verify this loader's own exact SHA-256 before import. The signed manifest then authorizes exactly one bootstrap artifact; ordered origins and offline media supply only digest-addressed bytes. HTTPS sources require an explicit bounded duration.\n`;
}

const invokedFromData = import.meta.url.startsWith('data:text/javascript');
const invokedFromFile = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedFromData || invokedFromFile) {
  const argv = invokedFromData ? process.argv.slice(1) : process.argv.slice(2);
  runFirstByte(argv).then((result) => {
    if (result.help) process.stdout.write(firstByteHelp());
    else if (result.bootstrap?.installed && argv.includes('--install-only')) process.stdout.write(`${JSON.stringify(result.bootstrap.installed)}\n`);
    process.exitCode = result.status;
  }).catch((error) => {
    process.stderr.write(`[devbridge-first-byte] ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
