import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_PACKAGE_FILES = 2_048;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;

function codePointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function hashProtectedAuthorityFile(file, maxBytes) {
  if (typeof file !== 'string' || file.length === 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('protected authority file measurement contract is invalid');
  }
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) {
    throw new Error(`protected runtime source is not a bounded real file: ${file}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  const after = await lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || bytes !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`protected runtime source changed while being measured: ${file}`);
  }
  return Object.freeze({ size: bytes, digest: hash.digest('hex') });
}

export async function snapshotProtectedAuthorityPackage(root) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('protected authority package root is required');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('DevBridge package source must be a real directory');
  const files = [];
  const visit = async (relativeDirectory) => {
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => codePointCompare(left.name, right.name));
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      const absolute = path.join(root, relative);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`DevBridge package source contains filesystem indirection: ${relative}`);
      if (info.isDirectory()) await visit(relative);
      else if (info.isFile()) {
        if (info.size > MAX_PACKAGE_FILE_BYTES) throw new Error(`DevBridge package source file exceeds the protected runtime bound: ${relative}`);
        files.push(relative);
        if (files.length > MAX_PACKAGE_FILES) throw new Error('DevBridge package source exceeds the protected runtime file-count bound');
      } else throw new Error(`DevBridge package source contains an unsupported entry: ${relative}`);
    }
  };
  const packageFile = path.join(root, 'package.json');
  await hashProtectedAuthorityFile(packageFile, MAX_PACKAGE_FILE_BYTES);
  files.push('package.json');
  await visit('src');
  files.sort(codePointCompare);
  const manifest = [];
  let total = 0;
  for (const relative of files) {
    const measured = await hashProtectedAuthorityFile(path.join(root, relative), MAX_PACKAGE_FILE_BYTES);
    total += measured.size;
    if (total > MAX_PACKAGE_BYTES) throw new Error('DevBridge package source exceeds the protected runtime byte bound');
    manifest.push(Object.freeze({ relative: relative.replaceAll(path.sep, '/'), size: measured.size, digest: measured.digest }));
  }
  const aggregate = createHash('sha256');
  for (const entry of manifest) aggregate.update(`${entry.relative}\0${entry.size}\0${entry.digest}\n`, 'utf8');
  return Object.freeze({ digest: aggregate.digest('hex'), files: Object.freeze(manifest) });
}

export async function measureProtectedAuthorityRuntimeCandidate({ packageRoot, nodeExecutable } = {}) {
  if (typeof packageRoot !== 'string' || packageRoot.length === 0 || typeof nodeExecutable !== 'string' || nodeExecutable.length === 0) {
    throw new TypeError('protected authority runtime candidate paths are required');
  }
  const [sourceSnapshot, node] = await Promise.all([
    snapshotProtectedAuthorityPackage(packageRoot),
    hashProtectedAuthorityFile(nodeExecutable, MAX_EXECUTABLE_BYTES),
  ]);
  return Object.freeze({
    sourceSnapshot,
    node,
    evidence: Object.freeze({ packageDigest: sourceSnapshot.digest, nodeDigest: node.digest }),
  });
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

export async function verifyProtectedAuthorityRuntimeAccess({
  generationDirectory,
  packageDirectory,
  nodeExecutable,
  generationManifest,
  ownerId = 0,
  groupId = 0,
  directoryMode = 0o755,
  fileMode = 0o444,
  executableMode = 0o555,
} = {}, {
  stat = lstat,
  readDirectory = readdir,
} = {}) {
  for (const [name, value] of Object.entries({ generationDirectory, packageDirectory, nodeExecutable, generationManifest })) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`protected authority ${name} is required`);
  }
  if (typeof stat !== 'function' || typeof readDirectory !== 'function') throw new TypeError('protected authority runtime access ports are invalid');
  for (const [name, value] of Object.entries({ ownerId, groupId, directoryMode, fileMode, executableMode })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`protected authority ${name} is invalid`);
  }
  const root = path.resolve(generationDirectory);
  for (const [name, value] of Object.entries({ packageDirectory, nodeExecutable, generationManifest })) {
    const target = path.resolve(value);
    const relative = path.relative(root, target);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`protected authority ${name} escaped its generation`);
    }
  }

  let entries = 0;
  const visit = async (target) => {
    const info = await stat(target);
    if (info.isSymbolicLink()) throw new Error('protected authority runtime contains filesystem indirection');
    if (info.uid !== ownerId || info.gid !== groupId) throw new Error('protected authority runtime ownership is invalid');
    const observedMode = info.mode & 0o7777;
    if (info.isDirectory()) {
      if (observedMode !== directoryMode) throw new Error('protected authority runtime directory mode is invalid');
      const children = await readDirectory(target, { withFileTypes: true });
      children.sort((left, right) => codePointCompare(left.name, right.name));
      for (const child of children) {
        entries += 1;
        if (entries > MAX_PACKAGE_FILES + 16) throw new Error('protected authority runtime exceeds the access-inspection bound');
        await visit(path.join(target, child.name));
      }
      return;
    }
    if (!info.isFile()) throw new Error('protected authority runtime contains an unsupported filesystem object');
    const expectedMode = samePath(target, nodeExecutable) ? executableMode : fileMode;
    if (observedMode !== expectedMode) throw new Error('protected authority runtime file mode is invalid');
  };
  await visit(root);
  return Object.freeze({ protocol: 'devbridge/protected-authority-runtime-access-v1', ready: true, entries });
}

export const PROTECTED_AUTHORITY_RUNTIME_BOUNDS = Object.freeze({
  packageFiles: MAX_PACKAGE_FILES,
  packageBytes: MAX_PACKAGE_BYTES,
  packageFileBytes: MAX_PACKAGE_FILE_BYTES,
  executableBytes: MAX_EXECUTABLE_BYTES,
});
