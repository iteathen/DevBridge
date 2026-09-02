import { createHash } from 'node:crypto';
import path from 'node:path';
import { BaseImageLibrary } from '../runtime/base-image-library.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { EnvironmentFoundation, UnavailableEnvironmentControl } from '../runtime/environment-foundation.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { PersistentEnvironments, UnavailablePersistentOperations } from '../runtime/persistent-environments.js';
import { preflightExecutionProfileMemory } from '../runtime/profile-resource-preflight.js';
import { HyperVEnvironment } from '../runtime/providers/hyperv-environment.js';
import { HyperVPersistentEnvironment } from '../runtime/providers/hyperv-persistent-environment.js';
import { LibvirtEnvironment } from '../runtime/providers/libvirt-environment.js';
import { LibvirtPersistentEnvironment } from '../runtime/providers/libvirt-persistent-environment.js';

function unavailableIdentity(identity, platform) {
  return createHash('sha256').update(`${identity}:persistent-environment:unavailable:${platform}`).digest('hex').slice(0, 32);
}

export function createExecutionProfileResourceGuard(foundation, {
  admitMemory = preflightExecutionProfileMemory,
} = {}) {
  if (!foundation || typeof foundation.observeEnvironment !== 'function' || typeof foundation.startEnvironment !== 'function') {
    throw new TypeError('environment lifecycle contract is incomplete');
  }
  if (typeof admitMemory !== 'function') throw new TypeError('execution profile memory admission must be a function');

  return new Proxy(foundation, {
    get(target, property) {
      if (property === 'startEnvironment') {
        return async (identity) => {
          const current = await target.observeEnvironment(identity);
          const observation = current?.observation;
          const running = ['running', 'blocked'].includes(observation?.state);
          if (observation?.exists === true && observation.owned === true && observation.compatible === true && !running) {
            admitMemory(current?.record?.settings);
          }
          return target.startEnvironment(identity);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function withRecoveryLifecycle(foundation, lifecycle) {
  return new Proxy(foundation, {
    get(target, property) {
      if (property === 'rebuildEnvironment') return (identity, options) => lifecycle.rebuild(identity, options);
      if (property === 'replaceEnvironment') return (identity, options) => lifecycle.replace(identity, options);
      if (property === 'recreateEnvironment') return (identity, options) => lifecycle.recreate(identity, options);
      if (property === 'retireSupersededEnvironment') return (identity, options) => lifecycle.retireSuperseded(identity, options);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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
  const persistentRoot = path.join(root, 'persistent');
  const images = new BaseImageLibrary({ directory: assetRoot });

  let control;
  let operations;
  if (platform === 'win32') {
    control = new HyperVEnvironment({ directory: controlDirectory, assetRoot, identity, invoke });
    operations = new HyperVPersistentEnvironment({
      directory: path.join(persistentRoot, 'operations'),
      machineRoot: path.join(path.resolve(stateDirectory), 'hv'),
      sourceRoot: assetRoot,
      identity,
      invoke,
    });
  } else if (platform === 'linux') {
    control = new LibvirtEnvironment({ directory: controlDirectory, assetRoot, identity, invoke });
    operations = new LibvirtPersistentEnvironment({ directory: path.join(persistentRoot, 'operations'), sourceRoot: assetRoot, identity, invoke });
  } else {
    const reason = 'no environment management implementation is available for this host platform';
    control = new UnavailableEnvironmentControl({ identity, reason });
    operations = new UnavailablePersistentOperations({ identity: unavailableIdentity(identity, platform), reason });
  }

  const source = {
    async resolve(sourceIdentity) {
      const observed = await images.verify(sourceIdentity);
      if (!observed.exists || !observed.usable || observed.verified !== true) throw new Error(observed.reason ?? 'environment source is unavailable');
      const media = await control.inspectImage({ location: observed.location });
      if (!media || media.usable !== true || media.parentIdentity != null) throw new Error(media?.reason ?? 'environment source media is unusable');
      if (String(media.format).toLowerCase() !== String(observed.entry.media.format).toLowerCase() || Number(media.virtualSize) !== Number(observed.entry.media.virtualSize)) {
        throw new Error('environment source media no longer matches its published identity');
      }
      return {
        identity: observed.identity,
        profile: observed.entry.profile,
        revision: observed.entry.generation,
        digest: observed.entry.digest,
        handle: { location: observed.location, format: String(media.format).toLowerCase() },
      };
    },
  };

  const lifecycle = new PersistentEnvironments({
    directory: path.join(persistentRoot, 'registry'),
    source,
    operations,
  });
  const guarded = createExecutionProfileResourceGuard(new EnvironmentFoundation({ identity, control, images, lifecycle }));
  return withRecoveryLifecycle(guarded, lifecycle);
}
