import { lstat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createEnvironmentFoundation } from '../app/environment-foundation.js';
import { BaseImageLibrary } from '../runtime/base-image-library.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { createImageLibraryAdoption, IMAGE_LIBRARY_ADOPTION_PROTOCOL } from './image-library-adoption.js';

async function sourceDirectory(root) {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('image adoption source must be a real directory');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function reconcileWindowsLifecycleAuthorityImages({
  stateDirectory,
  authorityDirectory,
  platform = process.platform,
  invoke = invokeCommand,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || typeof authorityDirectory !== 'string' || authorityDirectory.length === 0) {
    throw new TypeError('Windows lifecycle authority image-adoption directories are required');
  }
  if (typeof invoke !== 'function') throw new TypeError('Windows lifecycle authority image-adoption invocation contract is invalid');
  if (platform !== 'win32') return Object.freeze({ protocol: IMAGE_LIBRARY_ADOPTION_PROTOCOL, ready: true, changed: false, adopted: Object.freeze([]) });

  const sourceRoot = path.join(path.resolve(stateDirectory), 'environment-foundation', 'images');
  if (!await sourceDirectory(sourceRoot)) {
    return Object.freeze({ protocol: IMAGE_LIBRARY_ADOPTION_PROTOCOL, ready: true, changed: false, adopted: Object.freeze([]) });
  }
  const destinationRoot = path.resolve(authorityDirectory);
  if (sourceRoot.toLowerCase() === path.join(destinationRoot, 'environment-foundation', 'images').toLowerCase()) {
    throw new Error('Windows lifecycle authority image-adoption roots overlap');
  }

  const source = new BaseImageLibrary({ directory: sourceRoot });
  const destination = await createEnvironmentFoundation({ stateDirectory: destinationRoot, platform, invoke });
  const adoption = createImageLibraryAdoption({
    source,
    destination: Object.freeze({
      reconcile: () => destination.reconcileImages(),
      list: () => destination.listImages(),
      verify: (identity) => destination.verifyImage(identity),
      publish: (request) => destination.publishImage(request),
    }),
  });
  return adoption.reconcile();
}
