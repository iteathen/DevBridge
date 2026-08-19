import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { isWithin } from '../security/workspace-policy.js';

const DIGEST_RE = /^[0-9a-f]{40,64}$/u;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function normalizeChangedPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\0')) {
    throw new PolicyError('candidate changed path is invalid');
  }
  const portable = value.replace(/\\/gu, '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//u.test(portable) || portable.startsWith('//')) {
    throw new PolicyError(`candidate changed path must be repository-relative: ${value}`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized !== portable || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new PolicyError(`candidate changed path is not normalized: ${value}`);
  }
  return normalized;
}

async function inspectNoFollow(root, relative) {
  const rootResolved = path.resolve(root);
  const segments = relative.split('/');
  let cursor = rootResolved;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    if (!isWithin(rootResolved, cursor)) throw new PolicyError(`candidate path escaped worktree: ${relative}`);
    if (!(await exists(cursor))) {
      return { state: 'absent', path: cursor };
    }
    const info = await lstat(cursor);
    if (index < segments.length - 1 && info.isSymbolicLink()) {
      throw new PolicyError(`candidate path crosses a symbolic link/junction: ${relative}`);
    }
    if (index === segments.length - 1) return { state: 'present', path: cursor, info };
    if (!info.isDirectory()) throw new PolicyError(`candidate parent is not a directory: ${relative}`);
  }
  throw new PolicyError(`candidate path could not be inspected: ${relative}`);
}

function stableArtifactPayload({ baselineSha, entries }) {
  return JSON.stringify({
    protocol: 'devbridge/artifact-subject-v1',
    baselineSha,
    entries,
  });
}

export async function candidateArtifactSubject({ worktreeDir, baselineSha, changedFiles }) {
  if (typeof worktreeDir !== 'string' || worktreeDir.length === 0) throw new PolicyError('candidate subject worktree is required');
  if (typeof baselineSha !== 'string' || !DIGEST_RE.test(baselineSha)) throw new PolicyError('candidate subject baseline SHA is invalid');
  if (!Array.isArray(changedFiles)) throw new PolicyError('candidate subject changedFiles must be an array');

  const paths = [...new Set(changedFiles.map(normalizeChangedPath))].sort();
  const entries = [];
  for (const relative of paths) {
    const inspected = await inspectNoFollow(worktreeDir, relative);
    if (inspected.state === 'absent') {
      entries.push({ path: relative, kind: 'absent' });
      continue;
    }
    const { info } = inspected;
    if (info.isSymbolicLink()) {
      const target = await readlink(inspected.path);
      entries.push({
        path: relative,
        kind: 'symlink',
        targetSha256: sha256(Buffer.from(target, 'utf8')),
        targetBytes: Buffer.byteLength(target, 'utf8'),
      });
      continue;
    }
    if (!info.isFile()) throw new PolicyError(`candidate subject only supports files, symlinks, and deletions: ${relative}`);
    const bytes = await readFile(inspected.path);
    entries.push({
      path: relative,
      kind: 'file',
      sha256: sha256(bytes),
      size: bytes.length,
      executable: (info.mode & 0o111) !== 0,
    });
  }

  const payload = stableArtifactPayload({ baselineSha: baselineSha.toLowerCase(), entries });
  return {
    protocol: 'devbridge/artifact-subject-v1',
    baselineSha: baselineSha.toLowerCase(),
    changedFiles: paths,
    entries,
    subjectDigest: sha256(Buffer.from(payload, 'utf8')),
  };
}
