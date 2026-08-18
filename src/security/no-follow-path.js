import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { isWithin } from './workspace-policy.js';

export async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function assertNoFollowWithin(root, relative, { allowMissing = true } = {}) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relative);
  if (!isWithin(rootResolved, target)) throw new PolicyError(`path escaped owned root: ${relative}`);

  const rootInfo = await lstat(rootResolved);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new PolicyError('owned root must be a real directory');
  const rootReal = await realpath(rootResolved);

  const rel = path.relative(rootResolved, target);
  if (rel === '') return target;
  const segments = rel.split(path.sep).filter(Boolean);
  let cursor = rootResolved;
  let missing = false;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (missing || !(await pathExists(cursor))) {
      missing = true;
      continue;
    }
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new PolicyError(`path crosses a symbolic link/junction: ${relative}`);
    const canonical = await realpath(cursor);
    if (!isWithin(rootReal, canonical)) throw new PolicyError(`path resolves outside owned root: ${relative}`);
  }
  if (!allowMissing && missing) throw new PolicyError(`path does not exist: ${relative}`);
  return target;
}
