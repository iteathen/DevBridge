import { executionProfileSubject } from './execution-profile-routing.js';
import { requiredBootProtection } from '../values/boot-protection.js';

export function createEnvironmentMaterializationPolicy() {
  return Object.freeze({
    subject: Object.freeze({
      async resolve({ profile }) {
        return executionProfileSubject(profile);
      },
    }),
    settings: Object.freeze({
      async resolve({ resources, boot }) {
        if (!resources || !Number.isSafeInteger(resources.memoryBytes) || !Number.isSafeInteger(resources.processorCount)) throw new TypeError('environment materialization resources are invalid');
        if (boot?.requirement === 'efi-v1') return Object.freeze({ memoryBytes: resources.memoryBytes, processorCount: resources.processorCount, firmware: 'efi' });
        if (boot?.requirement === 'efi-protected-v1') return Object.freeze({
          memoryBytes: resources.memoryBytes,
          processorCount: resources.processorCount,
          firmware: 'efi',
          bootProtection: requiredBootProtection(),
        });
        throw new Error(`unsupported environment boot requirement: ${String(boot?.requirement ?? 'missing')}`);
      },
    }),
  });
}
