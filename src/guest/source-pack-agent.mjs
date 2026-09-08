import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const PART_NAME = /^part-[0-9]{1,6}-[0-9]{1,6}$/u;
const sha256 = value => createHash('sha256').update(value).digest('hex');
function exactDigest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('source pack digest is invalid');
  return value;
}
function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('source pack object is invalid');
  return value;
}

async function unpackSource(file, expectedDigest) {
  const expected = exactDigest(expectedDigest);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('source pack is not a bounded regular file');
  const compressed = await readFile(file);
  if (sha256(compressed) !== expected) throw new Error('source pack digest mismatch');
  const value = exactObject(JSON.parse(gunzipSync(compressed, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8')), ['protocol', 'parts']);
  if (value.protocol !== 'devbridge/source-part-pack-v1' || !Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 2048) throw new Error('source pack protocol or cardinality is invalid');
  const seen = new Set();
  let total = 0;
  const parts = value.parts.map(raw => {
    const part = exactObject(raw, ['name', 'size', 'digest', 'data']);
    if (typeof part.name !== 'string' || !PART_NAME.test(part.name) || seen.has(part.name)) throw new Error('packed source part name is invalid or duplicated');
    seen.add(part.name);
    if (!Number.isSafeInteger(part.size) || part.size < 0 || part.size > 2 * 1024 * 1024 || typeof part.data !== 'string') throw new Error('packed source part bounds are invalid');
    const bytes = Buffer.from(part.data, 'base64');
    total += bytes.length;
    if (bytes.toString('base64') !== part.data || bytes.length !== part.size || total > 2 * 1024 * 1024 || sha256(bytes) !== exactDigest(part.digest)) throw new Error('packed source part content is invalid');
    return { name: part.name, bytes };
  });
  const parent = path.dirname(file);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('source pack directory is invalid');
  const root = await realpath(parent);
  for (const part of parts) {
    const destination = path.join(root, part.name);
    try { const current = await lstat(destination); if (!current.isFile() || current.isSymbolicLink()) throw new Error('packed source destination is unsafe'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const temporary = path.join(root, `.${part.name}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, part.bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }
  await rm(file);
  process.stdout.write(`${JSON.stringify({ ready: true, digest: expected, parts: parts.length })}\n`);
}

async function neededParts(file, expectedDigest) {
  const expected = exactDigest(expectedDigest);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 24 * 1024 * 1024) throw new Error('source manifest is not a bounded regular file');
  const bytes = await readFile(file);
  if (bytes.length > 24 * 1024 * 1024 || sha256(bytes) !== expected) throw new Error('source manifest bytes changed');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.protocol !== 'devbridge/file-tree-v1' || !Array.isArray(manifest.entries) || manifest.entries.length > 100_000) throw new Error('source manifest is invalid');
  const parent = path.dirname(file);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('source part directory is invalid');
  const root = await realpath(parent);
  const seen = new Set(), needed = [];
  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue;
    if (!Array.isArray(entry.parts)) throw new Error('source manifest parts are invalid');
    for (const part of entry.parts) {
      if (!PART_NAME.test(part.name) || seen.has(part.name) || !Number.isSafeInteger(part.size) || part.size < 0 || part.size > 32 * 1024 * 1024) throw new Error('source manifest part is invalid');
      exactDigest(part.digest);
      seen.add(part.name);
      let matches = false;
      try {
        const selected = path.join(root, part.name);
        const current = await lstat(selected);
        if (current.isFile() && !current.isSymbolicLink() && current.size === part.size) {
          const handle = await open(selected, 'r');
          try {
            const content = Buffer.alloc(part.size);
            let offset = 0;
            while (offset < content.length) {
              const result = await handle.read(content, offset, content.length - offset, offset);
              if (result.bytesRead === 0) break;
              offset += result.bytesRead;
            }
            matches = offset === part.size && (await handle.stat()).size === part.size && sha256(content) === part.digest;
          } finally { await handle.close(); }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!matches) needed.push(part.name);
    }
  }
  process.stdout.write(`${JSON.stringify({ protocol: 'devbridge/source-parts-needed-v1', manifestDigest: expected, needed })}\n`);
}

try {
  const args = process.argv.slice(2);
  if (args.length === 3 && args[0] === 'needed') await neededParts(args[1], args[2]);
  else {
    if (args.length !== 2) throw new Error('source unpacking requires pack path and digest');
    await unpackSource(...args);
  }
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
