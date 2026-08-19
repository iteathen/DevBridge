import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';

const MAX_ARTIFACT_FILES = 100_000;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

function fail(message) { throw new Error(message); }

function compareNames(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function appendField(hash, name, value) {
  const nameBytes = Buffer.from(String(name), 'utf8');
  const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(nameBytes.length, 0);
  header.writeUInt32BE(valueBytes.length, 4);
  hash.update(header);
  hash.update(nameBytes);
  hash.update(valueBytes);
}

export function runtimeArtifactSha256Sync(runtimeDir, {
  maxFiles = MAX_ARTIFACT_FILES,
  maxBytes = MAX_ARTIFACT_BYTES,
} = {}) {
  const root = path.resolve(runtimeDir);
  const hash = createHash('sha256');
  appendField(hash, 'protocol', 'patch-poller/runtime-artifact-v1');
  let fileCount = 0;
  let totalBytes = 0;

  function walk(directory, prefix = '') {
    const entries = readdirSync(directory, { withFileTypes: true });
    entries.sort(compareNames);
    for (const entry of entries) {
      if (prefix === '' && entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = lstatSync(absolute);
      if (info.isDirectory()) {
        appendField(hash, 'directory', relative);
        walk(absolute, relative);
        continue;
      }
      fileCount += 1;
      if (fileCount > maxFiles) fail(`runtime artifact exceeds ${maxFiles} files`);
      if (info.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        totalBytes += Buffer.byteLength(target, 'utf8');
        if (totalBytes > maxBytes) fail(`runtime artifact exceeds ${maxBytes} bytes`);
        appendField(hash, 'symlink-path', relative);
        appendField(hash, 'symlink-target', target);
        continue;
      }
      if (!info.isFile()) fail(`runtime artifact contains unsupported filesystem object: ${relative}`);
      const bytes = readFileSync(absolute);
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) fail(`runtime artifact exceeds ${maxBytes} bytes`);
      appendField(hash, 'file-path', relative);
      appendField(hash, 'file-bytes', bytes);
    }
  }

  walk(root);
  return {
    protocol: 'patch-poller/runtime-artifact-v1',
    sha256: hash.digest('hex'),
    fileCount,
    totalBytes,
  };
}
