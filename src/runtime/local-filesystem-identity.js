import { lstat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function localPath(platform) {
  if (platform === 'win32') return path.win32;
  return path.posix;
}

function sameSpelling(left, right, platform) {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function containsSymbolicEntry(location, selectedPath, inspect) {
  const root = selectedPath.parse(location).root;
  let current = root;
  for (const segment of location.slice(root.length).split(selectedPath.sep).filter(Boolean)) {
    current = selectedPath.join(current, segment);
    if ((await inspect(current, { bigint: true })).isSymbolicLink()) return true;
  }
  return false;
}

export async function sameFilesystemIdentity(left, right, {
  platform = process.platform,
  inspect = lstat,
} = {}) {
  if (typeof left !== 'string' || typeof right !== 'string' || typeof inspect !== 'function') {
    throw new TypeError('filesystem identity inputs are invalid');
  }
  const selectedPath = localPath(platform);
  const a = selectedPath.resolve(left);
  const b = selectedPath.resolve(right);
  const lexicalMatch = sameSpelling(a, b, platform);
  if (platform !== 'win32' && !lexicalMatch) return false;
  if (await containsSymbolicEntry(a, selectedPath, inspect)
      || (!lexicalMatch && await containsSymbolicEntry(b, selectedPath, inspect))) return false;
  if (lexicalMatch) return true;
  const [leftIdentity, rightIdentity] = await Promise.all([
    inspect(a, { bigint: true }),
    inspect(b, { bigint: true }),
  ]);
  return leftIdentity.dev === rightIdentity.dev
    && leftIdentity.ino !== 0
    && leftIdentity.ino !== 0n
    && leftIdentity.ino === rightIdentity.ino;
}
