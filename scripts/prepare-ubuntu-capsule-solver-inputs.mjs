#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { UbuntuCapsuleSolverInputPreparer } from '../src/release/ubuntu-capsule-solver-input-preparer.mjs';
import { UbuntuInstallerLayerEntrySource } from '../src/release/ubuntu-installer-layer-entry-source.mjs';
import { UbuntuSnapshotAptLists } from '../src/release/ubuntu-snapshot-apt-lists.mjs';

const OPTIONS = new Set([
  '--destination', '--media', '--media-sha256', '--media-bytes', '--distribution', '--release',
  '--codename', '--architecture', '--snapshot', '--install-source', '--leaf-layer', '--layers',
  '--packages', '--xorriso', '--unsquashfs', '--apt-get', '--duration-ms',
]);

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) throw new TypeError(`${name} is invalid`);
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected > maximum) throw new TypeError(`${name} is invalid`);
  return selected;
}

function list(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0')) throw new TypeError(`${name} is invalid`);
  const values = value.split(',');
  if (values.some((item) => item.length < 1) || new Set(values).size !== values.length) throw new TypeError(`${name} is invalid`);
  return Object.freeze(values);
}

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new TypeError('Ubuntu solver-input arguments require option/value pairs');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!OPTIONS.has(name)) throw new TypeError(`Ubuntu solver-input option ${name} is unsupported`);
    if (values.has(name)) throw new TypeError(`Ubuntu solver-input option ${name} is duplicated`);
    values.set(name, argv[index + 1]);
  }
  for (const name of OPTIONS) if (!values.has(name)) throw new TypeError(`Ubuntu solver-input option ${name} is required`);
  for (const name of ['--destination', '--media', '--xorriso', '--unsquashfs', '--apt-get']) {
    if (!path.isAbsolute(values.get(name)) || values.get(name).includes('\0')) {
      throw new TypeError(`Ubuntu solver-input option ${name} must be an absolute local path`);
    }
  }
  return Object.freeze({
    destination: values.get('--destination'),
    media: values.get('--media'),
    mediaSha256: values.get('--media-sha256'),
    mediaBytes: positiveInteger(values.get('--media-bytes'), '--media-bytes'),
    distribution: values.get('--distribution'),
    release: values.get('--release'),
    codename: values.get('--codename'),
    architecture: values.get('--architecture'),
    snapshot: values.get('--snapshot'),
    installSource: values.get('--install-source'),
    leafLayer: values.get('--leaf-layer'),
    orderedLayers: list(values.get('--layers'), '--layers'),
    requestedPackages: list(values.get('--packages'), '--packages'),
    xorriso: values.get('--xorriso'),
    unsquashfs: values.get('--unsquashfs'),
    aptGet: values.get('--apt-get'),
    durationMs: positiveInteger(values.get('--duration-ms'), '--duration-ms', 2 * 60 * 60 * 1000),
  });
}

const args = parseArgs(process.argv.slice(2));
const controller = new AbortController();
const timeout = setTimeout(
  () => controller.abort(new Error(`Ubuntu solver-input preparation exceeded ${args.durationMs} ms`)),
  args.durationMs,
);
timeout.unref();
const interrupt = (name) => () => controller.abort(new Error(`Ubuntu solver-input preparation interrupted by ${name}`));
const onInterrupt = interrupt('SIGINT');
const onTerminate = interrupt('SIGTERM');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
try {
  const preparer = new UbuntuCapsuleSolverInputPreparer({
    installer: new UbuntuInstallerLayerEntrySource({ xorriso: args.xorriso, unsquashfs: args.unsquashfs }),
    snapshotLists: new UbuntuSnapshotAptLists({ executable: args.aptGet }),
  });
  const result = await preparer.prepare({
    destination: args.destination,
    media: args.media,
    mediaSha256: args.mediaSha256,
    mediaBytes: args.mediaBytes,
    distribution: args.distribution,
    release: args.release,
    codename: args.codename,
    architecture: args.architecture,
    snapshot: args.snapshot,
    installSource: args.installSource,
    leafLayer: args.leafLayer,
    orderedLayers: args.orderedLayers,
    requestedPackages: args.requestedPackages,
    signal: controller.signal,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  clearTimeout(timeout);
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
