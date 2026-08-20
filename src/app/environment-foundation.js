import path from 'node:path';
import { BaseImageLibrary } from '../runtime/base-image-library.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { EnvironmentFoundation, UnavailableEnvironmentControl } from '../runtime/environment-foundation.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { HyperVEnvironment } from '../runtime/providers/hyperv-environment.js';
import { LibvirtEnvironment } from '../runtime/providers/libvirt-environment.js';

export async function createEnvironmentFoundation({
  stateDirectory,
  platform = process.platform,
  invoke = invokeCommand,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('stateDirectory is required');
  const root = path.join(path.resolve(stateDirectory), 'environment-foundation');
  const identity = await loadOrCreateLocalIdentity({ directory: root });
  const assetRoot = path.join(root, 'images');
  const controlDirectory = path.join(root, 'control');
  const images = new BaseImageLibrary({ directory: assetRoot });

  let control;
  if (platform === 'win32') {
    control = new HyperVEnvironment({ directory: controlDirectory, assetRoot, identity, invoke });
  } else if (platform === 'linux') {
    control = new LibvirtEnvironment({ directory: controlDirectory, assetRoot, identity, invoke });
  } else {
    control = new UnavailableEnvironmentControl({ identity, reason: 'no environment management implementation is available for this host platform' });
  }

  return new EnvironmentFoundation({ identity, control, images });
}
