const active = new Map();

export function mutationLease(subject) {
  return {
    async acquire() {
      if (active.has(subject)) return null;
      let held = true;
      const result = {
        assertHeld() { if (!held || active.get(subject) !== result) throw new Error('mutation lease lost'); },
        async release() { held = false; if (active.get(subject) === result) active.delete(subject); },
      };
      active.set(subject, result);
      return result;
    },
  };
}
