import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUEST_IMAGE_PAYLOAD_PROTOCOL = 'devbridge/guest-image-payload-v1';

const MEMBERS = Object.freeze([
  'bridge-agent.mjs',
  'environment-bootstrap-agent.mjs',
  'linux-access-seed-agent.mjs',
  'network-seed-agent.mjs',
  'resource-agent.mjs',
  'workspace-agent.mjs',
]);
const TARGET_ROOT = '/usr/local/libexec/devbridge';
const DEFAULT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

function generationFor(files) {
  const hash = createHash('sha256');
  hash.update(`${GUEST_IMAGE_PAYLOAD_PROTOCOL}\0`, 'utf8');
  for (const file of files) hash.update(`${path.basename(file.path)}\0${file.sha256}\0${file.bytes}\0`, 'utf8');
  return `guest-image-${hash.digest('hex').slice(0, 24)}`;
}

async function loadMember(root, canonicalRoot, name) {
  const location = path.join(root, name);
  const lexicalInfo = await lstat(location);
  if (!lexicalInfo.isFile() || lexicalInfo.isSymbolicLink() || lexicalInfo.size < 1 || lexicalInfo.size > MAX_FILE_BYTES) {
    throw new Error('guest image payload member is invalid');
  }
  const canonicalFile = await realpath(location);
  if (path.dirname(canonicalFile) !== canonicalRoot || canonicalFile !== path.join(canonicalRoot, name)) {
    throw new Error('guest image payload member escaped its owning directory');
  }
  const content = await readFile(canonicalFile, 'utf8');
  if (content.includes('\0')) throw new Error('guest image payload member contains invalid bytes');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes !== lexicalInfo.size) throw new Error('guest image payload member changed during read');
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  return Object.freeze({ path: `${TARGET_ROOT}/${name}`, content, bytes, sha256 });
}

export async function createGuestImagePayload({ directory = DEFAULT_ROOT } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('guest image payload directory is invalid');
  const root = path.resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('guest image payload directory must be a real directory');
  const canonicalRoot = await realpath(root);
  const files = [];
  let totalBytes = 0;
  for (const name of MEMBERS) {
    const file = await loadMember(root, canonicalRoot, name);
    totalBytes += file.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('guest image payload exceeds its total size bound');
    files.push(file);
  }
  return Object.freeze({
    protocol: GUEST_IMAGE_PAYLOAD_PROTOCOL,
    generation: generationFor(files),
    files: Object.freeze(files),
  });
}
