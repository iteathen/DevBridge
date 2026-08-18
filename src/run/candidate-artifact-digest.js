import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { normalizePlanPath } from './controller-plan.js';
import { assertNoFollowWithin, pathExists } from '../security/no-follow-path.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function entryFor(root, relative) {
  const safe = normalizePlanPath(relative, 'candidate changed path');
  const parent = path.posix.dirname(safe);
  if (parent !== '.') await assertNoFollowWithin(root, parent, { allowMissing: false });
  const target = path.resolve(root, safe);
  if (!(await pathExists(target))) return { path: safe, kind: 'absent' };
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    return { path: safe, kind: 'symlink', target: await readlink(target) };
  }
  if (!info.isFile()) throw new PolicyError(`candidate changed path is not a regular file or symlink: ${safe}`);
  const bytes = await readFile(target);
  return {
    path: safe,
    kind: 'file',
    executable: (info.mode & 0o111) !== 0,
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

export async function candidateArtifactDigest({ baseSha, worktreeDir, changedFiles }) {
  if (!/^[0-9a-f]{40,64}$/iu.test(baseSha ?? '')) throw new PolicyError('candidate artifact base SHA is invalid');
  const paths = [...new Set((changedFiles ?? []).map((entry) => normalizePlanPath(entry, 'candidate changed path')))].sort();
  const entries = [];
  for (const relative of paths) entries.push(await entryFor(worktreeDir, relative));
  const normalized = { protocol: 'patch-poller/candidate-artifact-v1', baseSha: baseSha.toLowerCase(), entries };
  return { ...normalized, artifactSha256: sha256(Buffer.from(JSON.stringify(normalized), 'utf8')) };
}
