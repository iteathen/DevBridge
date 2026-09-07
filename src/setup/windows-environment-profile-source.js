import { createWindowsGuestImagePayload } from '../guest/windows-image-payload.js';
import { createEnvironmentProfileSource } from './environment-profile-source.js';
import { WINDOWS_PRODUCTION_OUTPUT } from './windows-production-output.js';

const REQUIREMENTS = Object.freeze([
  'source-control',
  'runtime-js',
  'build-config',
  'test-runner',
  'compiler-c',
  'compiler-cxx',
  'package-project',
]);

export function createWindowsEnvironmentProfileSource({ payloadFactory = createWindowsGuestImagePayload } = {}) {
  if (typeof payloadFactory !== 'function') throw new TypeError('profile source payload contract is incomplete');
  return createEnvironmentProfileSource({
    specification: async () => {
      const payload = await payloadFactory();
      return Object.freeze({
        profile: WINDOWS_PRODUCTION_OUTPUT.profile,
        schemaGeneration: 'windows-development-v1',
        guest: Object.freeze({ family: 'windows-11', generation: 'windows-11' }),
        imageGeneration: WINDOWS_PRODUCTION_OUTPUT.generation,
        bootstrapGeneration: payload?.generation,
        resources: Object.freeze({ memoryBytes: 4 * 1024 * 1024 * 1024, processorCount: 2 }),
        boot: 'efi-protected-v1',
        network: 'managed-egress-v1',
        requirements: REQUIREMENTS,
        enrollment: 'unique-guest-trust-v1',
        protectedStateClasses: Object.freeze([]),
      });
    },
  });
}
