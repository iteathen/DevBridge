import { createReadStream } from 'node:fs';
import { copyFile, lstat, open, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_PATTERN_BYTES = 64 * 1024;
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const PATCH_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

async function regularFile(location, label) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real regular file`);
  return info;
}

async function sha256File(location) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function normalizePatch(specification) {
  if (!specification || typeof specification !== 'object' || Array.isArray(specification)) throw new TypeError('patch specification is invalid');
  if (typeof specification.id !== 'string' || !PATCH_ID.test(specification.id)) throw new TypeError('patch id is invalid');
  if (!Number.isSafeInteger(specification.occurrences) || specification.occurrences < 1 || specification.occurrences > 64) throw new TypeError('patch occurrence count is invalid');
  if (typeof specification.before !== 'string' || typeof specification.after !== 'string') throw new TypeError('patch bytes must be strings');
  const before = Buffer.from(specification.before, 'utf8');
  const after = Buffer.from(specification.after, 'utf8');
  if (before.length === 0 || before.length > MAX_PATTERN_BYTES) throw new TypeError('patch pattern size is invalid');
  if (before.length !== after.length) throw new Error('patch replacement must preserve byte length');
  if (before.equals(after)) throw new Error('patch replacement must change bytes');
  return { id: specification.id, occurrences: specification.occurrences, before, after };
}

async function findOffsets(handle, size, pattern, chunkBytes) {
  const offsets = [];
  const seen = new Set();
  let position = 0;
  let carry = Buffer.alloc(0);
  while (position < size) {
    const requested = Math.min(chunkBytes, size - position);
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(chunk, 0, requested, position);
    if (bytesRead <= 0) break;
    const bytes = chunk.subarray(0, bytesRead);
    const combined = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
    const base = position - carry.length;
    let cursor = 0;
    while (cursor <= combined.length - pattern.length) {
      const index = combined.indexOf(pattern, cursor);
      if (index < 0) break;
      const absolute = base + index;
      if (absolute >= 0 && absolute + pattern.length <= size && !seen.has(absolute)) {
        seen.add(absolute);
        offsets.push(absolute);
      }
      cursor = index + 1;
    }
    const keep = Math.min(pattern.length - 1, combined.length);
    carry = keep > 0 ? Buffer.from(combined.subarray(combined.length - keep)) : Buffer.alloc(0);
    position += bytesRead;
  }
  offsets.sort((left, right) => left - right);
  return offsets;
}

function assertNoOverlap(ranges, candidate) {
  for (const existing of ranges) {
    if (candidate.start < existing.end && candidate.end > existing.start) {
      throw new Error(`patch ranges overlap: ${existing.id} and ${candidate.id}`);
    }
  }
}

export async function applyFixedLengthMediaPatches({ source, destination, patches, chunkBytes = DEFAULT_CHUNK_BYTES }) {
  if (typeof source !== 'string' || typeof destination !== 'string') throw new TypeError('source and destination are required');
  if (path.resolve(source) === path.resolve(destination)) throw new Error('source and destination must be distinct');
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > 32) throw new TypeError('patch list is invalid');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 64 * 1024 || chunkBytes > 64 * 1024 * 1024) throw new TypeError('patch scan chunk size is invalid');

  const normalized = patches.map(normalizePatch);
  const sourceInfo = await regularFile(source, 'source media');
  const sourceSha256 = await sha256File(source);
  await copyFile(source, destination, 1);

  try {
    await regularFile(destination, 'derived media');
    const handle = await open(destination, 'r+');
    try {
      const ranges = [];
      const applied = [];
      for (const patch of normalized) {
        const offsets = await findOffsets(handle, sourceInfo.size, patch.before, chunkBytes);
        if (offsets.length !== patch.occurrences) {
          throw new Error(`patch ${patch.id} expected ${patch.occurrences} occurrence(s) but found ${offsets.length}`);
        }
        for (const offset of offsets) {
          const range = { id: patch.id, start: offset, end: offset + patch.before.length };
          assertNoOverlap(ranges, range);
          ranges.push(range);
        }
        for (const offset of offsets) {
          const { bytesWritten } = await handle.write(patch.after, 0, patch.after.length, offset);
          if (bytesWritten !== patch.after.length) throw new Error(`patch ${patch.id} write was incomplete`);
        }
        applied.push({ id: patch.id, occurrences: offsets.length, bytes: patch.before.length });
      }
      await handle.sync();
      return {
        source: { bytes: sourceInfo.size, sha256: sourceSha256 },
        derived: { bytes: sourceInfo.size, sha256: await sha256File(destination) },
        applied,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}
