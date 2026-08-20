#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const CHUNK_BYTES = 8 * 1024 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

async function extract(executable, source, member) {
  const result = await execute(executable, ['e', '-so', source, member], {
    encoding: 'buffer',
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stderr?.length) throw new Error(`media extractor wrote unexpected stderr for ${member}`);
  return Buffer.from(result.stdout);
}

function patchedGrub(original) {
  let value = original.toString('utf8');
  const kernels = [
    'linux\t/casper/vmlinuz  ---',
    'linux\t/casper/hwe-vmlinuz  ---',
  ];
  for (const line of kernels) {
    if (!value.includes(line)) throw new Error(`expected Ubuntu boot entry is absent: ${line}`);
    value = value.replace(line, line.replace('---', 'autoinstall ---'));
  }
  const labels = [
    ['menuentry "Try or Install Ubuntu Server"', 'menuentry "Install Ubuntu"'],
    ['menuentry "Ubuntu Server with the HWE kernel"', 'menuentry "Install Ubuntu HWE"'],
  ];
  for (const [before, after] of labels) {
    if (!value.includes(before)) throw new Error(`expected Ubuntu menu label is absent: ${before}`);
    value = value.replace(before, after);
  }
  value = value.replace('set timeout=30', 'set timeout=0');
  const current = Buffer.from(value, 'utf8');
  if (current.length > original.length) throw new Error('patched Ubuntu boot configuration exceeds its fixed ISO extent');
  return Buffer.concat([current, Buffer.alloc(original.length - current.length, 0x20)]);
}

async function offsets(file, needle) {
  const matches = new Set();
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      const base = position - carry.length;
      let index = data.indexOf(needle);
      while (index >= 0) {
        matches.add(base + index);
        index = data.indexOf(needle, index + 1);
      }
      const retained = Math.min(Math.max(0, needle.length - 1), data.length);
      carry = Buffer.from(data.subarray(data.length - retained));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return [...matches].sort((left, right) => left - right);
}

async function replaceExact(file, before, after, label) {
  if (before.length !== after.length) throw new Error(`${label} replacement must preserve byte length`);
  const found = await offsets(file, before);
  if (found.length !== 1) throw new Error(`${label} must occur exactly once in the source media; found ${found.length}`);
  const handle = await open(file, 'r+');
  try {
    await handle.write(after, 0, after.length, found[0]);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sha256(file) {
  const hash = createHash('sha256');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

const source = path.resolve(argument('--source'));
const output = path.resolve(argument('--output'));
const extractor = path.resolve(argument('--extractor'));
if (source === output) throw new Error('source and output media paths must differ');
for (const [name, file] of [['source media', source], ['media extractor', extractor]]) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a real file`);
}

const originalGrub = await extract(extractor, source, 'boot\\grub\\grub.cfg');
const originalSums = await extract(extractor, source, 'md5sum.txt');
const updatedGrub = patchedGrub(originalGrub);
const oldDigest = createHash('md5').update(originalGrub).digest('hex');
const newDigest = createHash('md5').update(updatedGrub).digest('hex');
const oldSum = Buffer.from(`${oldDigest}  ./boot/grub/grub.cfg`, 'utf8');
const newSum = Buffer.from(`${newDigest}  ./boot/grub/grub.cfg`, 'utf8');
if (!originalSums.includes(oldSum)) throw new Error('Ubuntu media checksum does not bind the extracted boot configuration');

try {
  await copyFile(source, output, constants.COPYFILE_EXCL);
  await replaceExact(output, originalGrub, updatedGrub, 'Ubuntu boot configuration');
  await replaceExact(output, oldSum, newSum, 'Ubuntu boot configuration checksum');
  const observedGrub = await extract(extractor, output, 'boot\\grub\\grub.cfg');
  const observedSums = await extract(extractor, output, 'md5sum.txt');
  if (!observedGrub.equals(updatedGrub) || !observedSums.includes(newSum)) throw new Error('derived Ubuntu media verification failed');
  process.stdout.write(`${JSON.stringify({
    source,
    output,
    sha256: await sha256(output),
    grubMd5: newDigest,
    unattendedEntries: 2,
  })}\n`);
} catch (error) {
  await rm(output, { force: true }).catch(() => {});
  throw error;
}
