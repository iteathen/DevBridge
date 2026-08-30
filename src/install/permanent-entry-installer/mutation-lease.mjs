import { createProcessActivityLease } from '../../runtime/process-activity-lease.js';

export function createMutationLease(options = {}) {
  const lease = createProcessActivityLease(options);
  return Object.freeze({
    observe: lease.observe,
    acquire(root) {
      try { return lease.acquire(root); }
      catch (error) {
        if (error?.message === 'Another protected activity is active for this root.') {
          throw new Error('Another installation mutation is active for this root.', { cause: error });
        }
        if (error?.message === 'Could not acquire the activity lease safely.') {
          throw new Error('Could not acquire the installation mutation lease safely.', { cause: error });
        }
        throw error;
      }
    },
  });
}
