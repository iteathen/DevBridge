import path from 'node:path';
import { BaseImageLibrary } from '../runtime/base-image-library.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  EnvironmentProfileConfigurationRegistry,
} from '../runtime/environment-profile-configuration.js';
import { createEnvironmentProfileConfigurationStateStore } from '../state/environment-profile-configuration-state-store.js';

const MAX_SOURCES = 64;

function stableSubjects(raw) {
  if (!Array.isArray(raw) || raw.length > 4_096) throw new TypeError('setup profile subjects are invalid');
  const values = raw.map((entry) => {
    const value = String(entry?.id ?? '');
    if (!/^\d+$/u.test(value)) throw new TypeError('setup profile subject is not a stable identity');
    return value;
  });
  if (new Set(values).size !== values.length) throw new TypeError('setup profile subjects contain duplicates');
  return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
}

function declarationSources(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_SOURCES) throw new TypeError('setup profile declaration sources are invalid');
  return Object.freeze(raw.map((source) => {
    if (!source || typeof source.resolve !== 'function') throw new TypeError('setup profile declaration source contract is incomplete');
    return source;
  }));
}

function declarations(raw) {
  const values = raw.filter((value) => value != null).sort((left, right) => left.profile.localeCompare(right.profile));
  if (new Set(values.map((value) => value.profile)).size !== values.length) throw new Error('setup profile declarations contain duplicate profiles');
  return Object.freeze(values);
}

export function createSetupEnvironmentProfileConfiguration({ stateDirectory, sources, identify, now } = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('setup profile stateDirectory is required');
  if (typeof identify !== 'function') throw new TypeError('setup profile workspace identity contract is incomplete');
  const selectedSources = declarationSources(sources);
  const root = path.resolve(stateDirectory);
  const registry = new EnvironmentProfileConfigurationRegistry({
    port: createEnvironmentProfileConfigurationStateStore(path.join(root, 'environment-profile-configuration', 'state.json')),
    ...(now ? { now } : {}),
  });
  const images = new BaseImageLibrary({ directory: path.join(root, 'environment-foundation', 'images') });
  return Object.freeze({
    current: () => registry.current(),
    async reconcile({ subjects = [] } = {}) {
      const selectedSubjects = stableSubjects(subjects);
      const current = await registry.current();
      await images.reconcile();
      const inventory = await images.list();
      const resolved = await Promise.all(selectedSources.map((source) => source.resolve({
        images: inventory,
        current,
        subjects: selectedSubjects,
        identify,
      })));
      const configuration = Object.freeze({
        protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
        declarations: declarations(resolved),
      });
      return registry.publish(configuration);
    },
  });
}
