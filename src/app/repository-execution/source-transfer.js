import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const PROTOCOL = 'devbridge/source-part-pack-v1';
const RAW_BYTES = 2 * 1024 * 1024;
const MAX_PARTS = 2048;
const PACK_BYTES = 4 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function active(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('source transfer was cancelled');
}

// Packing is a workspace transport decision. The original tree manifest remains
// the authority for every file and part, including parts too large for a pack.
export async function transferRepositorySource({ snapshot, writePack, unpack, writePart, signal = null, onActivity = null }) {
  const parts = snapshot.manifest.entries.filter(entry => entry.type === 'file').flatMap(entry => entry.parts);
  let batch = [], size = 0, completed = 0;
  const started = Date.now();
  const progress = () => onActivity?.({ activity: `source-transfer ${completed}/${parts.length} parts`, elapsedMs: Date.now() - started, at: new Date().toISOString() });
  const flush = async () => {
    if (batch.length === 0) return;
    active(signal);
    const serialized = Buffer.from(JSON.stringify({ protocol: PROTOCOL, parts: batch }));
    if (serialized.length > PACK_BYTES) throw new Error('source part pack exceeds its byte bound');
    const bytes = gzipSync(serialized);
    const identity = digest(bytes);
    await writePack(bytes, { signal, onProgress: ({ offset, total }) => onActivity?.({
      activity: `source-transfer ${completed}/${parts.length} parts; pack ${offset}/${total} bytes`,
      elapsedMs: Date.now() - started, at: new Date().toISOString(),
    }) });
    active(signal);
    const result = await unpack(identity, { signal, onActivity });
    if (result?.ready !== true || result.digest !== identity || result.parts !== batch.length) throw new Error('source part pack receipt does not match its subject');
    completed += batch.length;
    batch = []; size = 0;
    progress();
  };
  for (const part of parts) {
    active(signal);
    if (part.size > RAW_BYTES) {
      await flush();
      await writePart(part, request => { active(signal); return snapshot.readPart(part.name, request); });
      completed += 1; progress();
      continue;
    }
    if (size + part.size > RAW_BYTES || batch.length === MAX_PARTS) await flush();
    const response = await snapshot.readPart(part.name, { offset: 0, limit: part.size });
    const bytes = Buffer.from(response.data);
    if (response.eof !== true || bytes.length !== part.size || digest(bytes) !== part.digest) throw new Error('source part changed before packing');
    batch.push({ name: part.name, size: part.size, digest: part.digest, data: bytes.toString('base64') });
    size += bytes.length;
  }
  await flush();
  active(signal);
}
