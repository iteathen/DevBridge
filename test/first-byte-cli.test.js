import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseFirstByteArguments } from '../src/bootstrap/first-byte-cli.mjs';
import * as sourceContract from '../src/bootstrap/first-byte-cli.mjs';
import * as standaloneContract from '../first-byte-devbridge.mjs';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function required(...sources) {
  return [
    '--manifest', path.resolve('release.json'),
    '--public-key', path.resolve('release.pem'),
    '--manifest-sha256', DIGEST_A,
    '--public-key-sha256', DIGEST_B,
    '--key-id', 'release-key-1',
    '--cache', path.resolve('release-cache'),
    ...sources,
  ];
}

test('first-byte CLI preserves locally selected source order and isolates bootstrap arguments', () => {
  const parsed = parseFirstByteArguments([
    ...required(
      '--origin', 'https://one.example/objects/',
      '--offline', path.resolve('offline'),
      '--origin', 'https://two.example/objects/',
      '--source-duration-ms', '45000',
    ),
    '--', '--install-only', '--ref', 'a'.repeat(40), '--home', path.resolve('home'),
  ]);
  assert.equal(parsed.help, false);
  assert.equal(parsed.sourceDurationMs, 45_000);
  assert.deepEqual(parsed.sources.map((entry) => entry.kind), ['https', 'filesystem', 'https']);
  assert.deepEqual(parsed.bootstrapArguments.slice(0, 3), ['--install-only', '--ref', 'a'.repeat(40)]);
  assert.equal(Object.isFrozen(parsed.sources), true);

  const bootstrapHelp = parseFirstByteArguments([
    ...required('--offline', path.resolve('offline')),
    '--', '--help',
  ]);
  assert.deepEqual(bootstrapHelp.bootstrapArguments, ['--help']);
});

test('first-byte CLI has no implicit HTTPS duration or source policy', () => {
  assert.throws(() => parseFirstByteArguments(required('--origin', 'https://one.example/objects/')), /source-duration-ms/u);
  assert.throws(() => parseFirstByteArguments(required('--offline', path.resolve('offline'), '--source-duration-ms', '45000')), /only valid with HTTPS/u);
  assert.throws(() => parseFirstByteArguments(required()), /at least one source/u);
  assert.throws(() => parseFirstByteArguments([...required('--offline', path.resolve('offline')), '--unknown']), /Unsupported first-byte argument/u);
});

test('first-byte CLI rejects duplicate authority fields, relative paths, invalid duration, and missing delimiter', () => {
  assert.throws(() => parseFirstByteArguments([...required('--offline', path.resolve('offline')), '--manifest', path.resolve('other.json')]), /Only one --manifest/u);
  assert.throws(() => parseFirstByteArguments(required('--offline', 'relative-media')), /absolute/u);
  assert.throws(() => parseFirstByteArguments(required('--origin', 'https://one.example/objects/', '--source-duration-ms', '999')), /duration/u);
  assert.throws(() => parseFirstByteArguments([...required('--offline', path.resolve('offline')), '--install-only']), /Unsupported first-byte argument/u);
});

test('first-byte CLI help is side-effect free and rejects mixed input', () => {
  assert.deepEqual(parseFirstByteArguments(['--help']), {
    help: true,
    manifest: null,
    publicKey: null,
    expectedManifestSha256: null,
    expectedPublicKeySha256: null,
    expectedKeyId: null,
    cache: null,
    sourceDurationMs: null,
    sources: [],
    bootstrapArguments: [],
  });
  assert.throws(() => parseFirstByteArguments(['--help', '--manifest', path.resolve('release.json')]), /help must be used alone/u);
});

test('generated first-byte artifact preserves the public contract and executes from a data import', () => {
  assert.deepEqual(Object.keys(standaloneContract).sort(), Object.keys(sourceContract).sort());
  const source = readFileSync(new URL('../first-byte-devbridge.mjs', import.meta.url));
  const loader = "const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);await import('data:text/javascript;base64,'+Buffer.concat(chunks).toString('base64'))";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', loader, '--', '--help'], {
    encoding: 'utf8', input: source, shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DevBridge signed first-byte loader/u);
  assert.match(result.stdout, /verify this loader's own exact SHA-256/u);
});
