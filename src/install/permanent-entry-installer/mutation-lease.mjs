import { createProcessActivityLease } from '../../runtime/process-activity-lease.js';

export function createMutationLease(options = {}) {
  const lease = createProcessActivityLease(options);
  function translated(error) {
    if (error?.message === 'Another protected activity is active for this root.') {
      return new Error('Another installation mutation is active for this root.', { cause: error });
    }
    if (error?.message === 'Could not acquire the activity lease safely.') {
      return new Error('Could not acquire the installation mutation lease safely.', { cause: error });
    }
    return error;
  }
  return Object.freeze({
    observe: lease.observe,
    acquire(root) {
      try { return lease.acquire(root); }
      catch (error) { throw translated(error); }
    },
    async run(root, operation) {
      try { return await lease.run(root, operation); }
      catch (error) { throw translated(error); }
    },
  });
}
