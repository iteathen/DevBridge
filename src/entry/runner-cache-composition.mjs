import process from 'node:process';
import { invokeCommand } from '../runtime/command-invocation.js';
import { createExactArtifactSet } from '../runtime/exact-artifact-set.js';
import { createExactDirectory } from '../runtime/exact-directory.js';
import { createWindowsFilesystemEntryObserver } from '../runtime/providers/windows-filesystem-entry-observer.js';
import { createRunnerCacheOwnership } from './runner-cache-ownership.mjs';

export function createRunnerCacheComposition({ cacheRoot, stateRoot } = {}, {
  platform = process.platform,
  invoke = invokeCommand,
  attributeObserverFactory = createWindowsFilesystemEntryObserver,
  artifactFactory = createExactArtifactSet,
  directoryFactory = createExactDirectory,
  ownershipFactory = createRunnerCacheOwnership,
} = {}) {
  const observer = platform === 'win32' ? attributeObserverFactory({ invoke }) : null;
  const reparse = observer ? {
    inspectReparse: (location) => observer.isReparse(location),
    inspectReparseBatch: (locations) => observer.inspectReparseBatch(locations),
  } : {};
  const directories = directoryFactory({ platform, ...reparse });
  return Object.freeze({
    cacheRoot,
    artifacts: artifactFactory({ platform, ...reparse }),
    directories,
    inspectReparse: observer
      ? (location, info) => observer.isReparse(location, info)
      : async (_location, info) => info.isSymbolicLink(),
    ownership: ownershipFactory({ stateRoot, directories }),
  });
}
