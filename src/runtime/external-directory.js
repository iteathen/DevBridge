import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function canonicalExternalDirectory(directory, excludedRoot) {
  if (directory == null) return null;
  if (typeof directory !== 'string' || directory.length === 0 ||
      typeof excludedRoot !== 'string' || excludedRoot.length === 0) {
    throw new TypeError('directory boundary paths are required');
  }
  const resolved = path.resolve(directory);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('selected directory must be a real non-symlink directory');
  }
  let current = path.dirname(resolved);
  while (true) {
    const parentInfo = await lstat(current);
    if (parentInfo.isSymbolicLink()) throw new Error('selected directory must not use filesystem indirection');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const [canonical, canonicalExcludedRoot] = await Promise.all([
    realpath(resolved),
    realpath(path.resolve(excludedRoot)),
  ]);
  if (isWithin(canonicalExcludedRoot, canonical)) {
    throw new Error('selected directory must be outside the excluded root');
  }
  return canonical;
}
