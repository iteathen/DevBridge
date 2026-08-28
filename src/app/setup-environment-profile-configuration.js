import path from 'node:path';
import { executionWorkspaceIdentity } from './execution-profile-routing.js';
import { BaseImageLibrary } from '../runtime/base-image-library.js';
import {
  ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
  EnvironmentProfileConfigurationRegistry,
} from '../runtime/environment-profile-configuration.js';
import { ENVIRONMENT_DECLARATION_PROTOCOL } from '../runtime/environment-declaration.js';
import { createEnvironmentProfileConfigurationStateStore } from '../state/environment-profile-configuration-state-store.js';
import { UBUNTU_SETUP_OUTPUT, UBUNTU_SETUP_SOURCE_POLICY } from '../setup/ubuntu-authority.js';

const SCHEMA_GENERATION = 'linux-development-v1';
const BOOT_REQUIREMENT = 'efi-v1';
const NETWORK_REQUIREMENT = 'managed-egress-v1';
const ENROLLMENT_REQUIREMENT = 'unique-guest-trust-v1';
const MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const PROCESSOR_COUNT = 2;
const REQUIREMENTS = Object.freeze([
  'source-control',
  'runtime-js',
  'build-config',
  'test-runner',
  'compiler-c',
  'compiler-cxx',
  'package-project',
]);

function stableSubjects(raw) {
  if (!Array.isArray(raw) || raw.length > 4096) throw new TypeError('setup profile subjects are invalid');
  const values = raw.map((entry) => {
    const value = String(entry?.id ?? '');
    if (!/^\d+$/u.test(value)) throw new TypeError('setup profile subject is not a stable identity');
    return value;
  });
  if (new Set(values).size !== values.length) throw new TypeError('setup profile subjects contain duplicates');
  return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
}

function selectedImage(entries, current) {
  const matches = entries.filter((entry) => entry?.retiredAt == null
    && entry.profile === UBUNTU_SETUP_OUTPUT.profile
    && entry.generation === UBUNTU_SETUP_OUTPUT.generation);
  if (matches.length > 1) throw new Error('setup profile image generation is ambiguous');
  if (matches.length === 1) return matches[0];
  const retained = current?.configuration?.declarations?.find((entry) => entry.profile === UBUNTU_SETUP_OUTPUT.profile) ?? null;
  if (retained == null) return null;
  if (retained.image.generation !== UBUNTU_SETUP_OUTPUT.generation
      || retained.bootstrap.generation !== UBUNTU_SETUP_OUTPUT.bootstrap) {
    throw new Error('accepted setup profile no longer matches current output authority');
  }
  return Object.freeze({
    identity: retained.image.identity,
    profile: retained.profile,
    generation: retained.image.generation,
    provenance: Object.freeze({ bootstrap: retained.bootstrap.generation }),
  });
}

function declarationFor(image, subjects) {
  const bootstrap = image?.provenance?.bootstrap;
  if (typeof bootstrap !== 'string' || bootstrap !== UBUNTU_SETUP_OUTPUT.bootstrap) {
    throw new Error('setup profile image bootstrap identity does not match accepted output authority');
  }
  return Object.freeze({
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: UBUNTU_SETUP_OUTPUT.profile,
    schemaGeneration: SCHEMA_GENERATION,
    guest: Object.freeze({ family: 'ubuntu', generation: UBUNTU_SETUP_SOURCE_POLICY.release }),
    image: Object.freeze({ identity: image.identity, generation: image.generation }),
    resources: Object.freeze({ memoryBytes: MEMORY_BYTES, processorCount: PROCESSOR_COUNT }),
    boot: Object.freeze({ requirement: BOOT_REQUIREMENT }),
    network: Object.freeze({ requirement: NETWORK_REQUIREMENT }),
    bootstrap: Object.freeze({ generation: bootstrap, requirements: REQUIREMENTS }),
    enrollment: Object.freeze({ requirement: ENROLLMENT_REQUIREMENT }),
    workspaces: Object.freeze(subjects.map((authority) => Object.freeze({
      identity: executionWorkspaceIdentity(authority, UBUNTU_SETUP_OUTPUT.profile),
      authority,
    }))),
    protectedStateClasses: Object.freeze([]),
  });
}

export function createSetupEnvironmentProfileConfiguration({ stateDirectory, now } = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('setup profile stateDirectory is required');
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
      const image = selectedImage(await images.list(), current);
      const configuration = Object.freeze({
        protocol: ENVIRONMENT_PROFILE_CONFIGURATION_PROTOCOL,
        declarations: Object.freeze(image == null ? [] : [declarationFor(image, selectedSubjects)]),
      });
      return registry.publish(configuration);
    },
  });
}
