import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PROTOCOL = 'devbridge/windows-lifecycle-authority-migration-safety-v1';
const MAX_JSON_BYTES = 4 * 1024 * 1024;

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

async function realFile(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('legacy authority migration encountered filesystem indirection');
    if (!info.isFile()) throw new Error('legacy authority migration state is not a regular file');
    return info;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function realDirectory(directory) {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error('legacy authority migration encountered filesystem indirection');
    if (!info.isDirectory()) throw new Error('legacy authority migration state is not a real directory');
    return info;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function hasMaterializedEntries(directory) {
  if (!await realDirectory(directory)) return false;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error('legacy authority migration encountered filesystem indirection');
    if (info.isFile()) return true;
    if (!info.isDirectory()) throw new Error('legacy authority migration state contains an unsupported entry');
    if (await hasMaterializedEntries(candidate)) return true;
  }
  return false;
}

async function readBoundedJson(file, expectedProtocol) {
  const info = await realFile(file);
  if (!info) return null;
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_JSON_BYTES) {
    throw new Error('legacy authority migration state exceeds the inspection bound');
  }
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('legacy authority migration state is invalid JSON'); }
  if (!plainObject(value) || value.protocol !== expectedProtocol) {
    throw new Error('legacy authority migration state protocol is invalid');
  }
  return value;
}

function result({ ready, blocker = null, classification = 'portable' }) {
  return Object.freeze({ protocol: PROTOCOL, ready, blocker, classification });
}

export async function inspectWindowsLifecycleAuthorityMigrationSafety({
  stateDirectory,
  platform = process.platform,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || stateDirectory.includes('\0')) {
    throw new TypeError('Windows lifecycle authority migration-safety stateDirectory is required');
  }
  if (platform !== 'win32') return result({ ready: true, classification: 'not-applicable' });

  const root = path.resolve(stateDirectory);
  const foundation = path.join(root, 'environment-foundation');
  const images = path.join(foundation, 'images');
  const persistentOperations = path.join(foundation, 'persistent', 'operations');
  const recovery = path.join(foundation, 'image-recovery');

  const catalog = await readBoundedJson(path.join(images, 'catalog.json'), 'devbridge/base-image-library-v1');
  if (catalog && (!plainObject(catalog.images) || !plainObject(catalog.operations))) {
    throw new Error('legacy image-library catalog shape is invalid for migration');
  }
  const catalogRequiresImageMigration = catalog && (Object.keys(catalog.images).length > 0 || Object.keys(catalog.operations).length > 0);
  const materializedImagesRequireMigration = await hasMaterializedEntries(path.join(images, 'objects'))
    || await hasMaterializedEntries(path.join(images, 'staging'));

  const operations = await readBoundedJson(path.join(persistentOperations, 'state.json'), 'devbridge/hyperv-persistent-environment-v1');
  if (operations && !plainObject(operations.records)) {
    throw new Error('legacy persistent-provider registry shape is invalid for migration');
  }
  if (operations && Object.keys(operations.records).length > 0) {
    return result({
      ready: false,
      classification: 'provider-aware-storage-migration-required',
      blocker: 'Legacy Windows lifecycle authority contains persistent Hyper-V backing storage with path-bound provider records. Provider-aware storage migration is required before the protected authority can be established.',
    });
  }
  if (await hasMaterializedEntries(path.join(persistentOperations, 'objects'))) {
    return result({
      ready: false,
      classification: 'provider-aware-storage-migration-required',
      blocker: 'Legacy Windows lifecycle authority contains persistent backing-store objects without a safely portable empty provider registry. Provider-aware storage migration is required before the protected authority can be established.',
    });
  }

  if (await hasMaterializedEntries(recovery)) {
    return result({
      ready: false,
      classification: 'provider-aware-recovery-migration-required',
      blocker: 'Legacy Windows lifecycle authority contains image-recovery working state. Complete or reconcile that recovery state before protected authority migration can continue.',
    });
  }

  if (catalogRequiresImageMigration || materializedImagesRequireMigration) {
    return result({
      ready: false,
      classification: 'provider-aware-image-migration-required',
      blocker: catalogRequiresImageMigration
        ? 'Legacy Windows lifecycle authority contains image-library state whose filesystem identity cannot be preserved by generic protected-state copying. Provider-aware image migration is required before the protected authority can be established.'
        : 'Legacy Windows lifecycle authority contains image bytes without a safely portable empty catalog. Provider-aware image migration is required before the protected authority can be established.',
    });
  }

  return result({ ready: true });
}

export { PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_MIGRATION_SAFETY_PROTOCOL };
