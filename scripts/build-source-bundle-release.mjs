#!/usr/bin/env node
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildSourceBundleRelease } from '../src/release/source-bundle-release-builder.mjs';
import { sameObservedFilesystemIdentity } from '../src/runtime/local-filesystem-identity.js';

const MAX_KEY_BYTES = 16 * 1024;
const OPTIONS = new Set([
  '--repository', '--destination', '--head', '--release-id', '--sequence', '--key-id',
  '--private-key', '--public-key', '--chunk-bytes',
]);

function parsePositive(value, name) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) throw new TypeError(`${name} is invalid`);
  const selected = Number(value);
  if (!Number.isSafeInteger(selected)) throw new TypeError(`${name} is invalid`);
  return selected;
}

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new TypeError('source-bundle release arguments require option/value pairs');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!OPTIONS.has(name)) throw new TypeError(`source-bundle release option ${name} is unsupported`);
    if (values.has(name)) throw new TypeError(`source-bundle release option ${name} is duplicated`);
    values.set(name, value);
  }
  for (const name of OPTIONS) {
    if (name === '--chunk-bytes') continue;
    if (!values.has(name)) throw new TypeError(`source-bundle release option ${name} is required`);
  }
  for (const name of ['--repository', '--destination', '--private-key', '--public-key']) {
    if (!path.isAbsolute(values.get(name)) || values.get(name).includes('\0')) throw new TypeError(`source-bundle release option ${name} must be an absolute local path`);
  }
  return Object.freeze({
    repository: values.get('--repository'),
    destination: values.get('--destination'),
    head: values.get('--head'),
    releaseId: values.get('--release-id'),
    sequence: parsePositive(values.get('--sequence'), '--sequence'),
    keyId: values.get('--key-id'),
    privateKey: values.get('--private-key'),
    publicKey: values.get('--public-key'),
    chunkBytes: values.has('--chunk-bytes') ? parsePositive(values.get('--chunk-bytes'), '--chunk-bytes') : undefined,
  });
}

async function readKey(location, name) {
  const before = await lstat(location, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_KEY_BYTES)) {
    throw new Error(`${name} must be one bounded unlinked regular file`);
  }
  const handle = await open(location, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.nlink !== 1n || held.size !== before.size
        || !sameObservedFilesystemIdentity(before, held)
        || held.mtimeNs !== before.mtimeNs || held.ctimeNs !== before.ctimeNs) {
      throw new Error(`${name} changed while opening`);
    }
    const bytes = await handle.readFile();
    const after = await lstat(location, { bigint: true });
    if (bytes.length !== Number(before.size) || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n
        || !sameObservedFilesystemIdentity(held, after)
        || after.size !== held.size || after.mtimeNs !== held.mtimeNs || after.ctimeNs !== held.ctimeNs) {
      throw new Error(`${name} changed while reading`);
    }
    return bytes;
  } finally { await handle.close(); }
}

const args = parseArgs(process.argv.slice(2));
const [privateKeyBytes, publicKeyBytes] = await Promise.all([
  readKey(args.privateKey, 'source-bundle private key'),
  readKey(args.publicKey, 'source-bundle public key'),
]);
const input = {
  repository: args.repository,
  destination: args.destination,
  head: args.head,
  releaseId: args.releaseId,
  sequence: args.sequence,
  keyId: args.keyId,
  privateKeyBytes,
  publicKeyBytes,
};
if (args.chunkBytes != null) input.chunkBytes = args.chunkBytes;
const result = await buildSourceBundleRelease(input);
process.stdout.write(`${JSON.stringify(result)}\n`);
