import { createEnvironmentProfileSource } from './environment-profile-source.js';
import { UBUNTU_SETUP_OUTPUT, UBUNTU_SETUP_SOURCE_POLICY } from './ubuntu-authority.js';

const REQUIREMENTS = Object.freeze([
  'source-control',
  'runtime-js',
  'build-config',
  'test-runner',
  'compiler-c',
  'compiler-cxx',
  'package-project',
]);

export function createUbuntuEnvironmentProfileSource() {
  return createEnvironmentProfileSource({
    specification: () => Object.freeze({
      profile: UBUNTU_SETUP_OUTPUT.profile,
      schemaGeneration: 'linux-development-v1',
      guest: Object.freeze({ family: 'ubuntu', generation: UBUNTU_SETUP_SOURCE_POLICY.release }),
      imageGeneration: UBUNTU_SETUP_OUTPUT.generation,
      bootstrapGeneration: UBUNTU_SETUP_OUTPUT.bootstrap,
      resources: Object.freeze({ memoryBytes: 2 * 1024 * 1024 * 1024, processorCount: 2 }),
      boot: 'efi-v1',
      network: 'managed-egress-v1',
      requirements: REQUIREMENTS,
      enrollment: 'unique-guest-trust-v1',
      protectedStateClasses: Object.freeze([]),
    }),
  });
}
