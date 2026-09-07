function boundedReason(value) {
  return String(value?.message ?? value).slice(0, 512);
}

export function createCompletionReconciliation() {
  const run = async (actions) => {
    if (!Array.isArray(actions)) throw new TypeError('completion actions must be an array');
    const reasons = [];
    for (const action of actions) {
      if (!action || typeof action !== 'object' || typeof action.perform !== 'function' || typeof action.failure !== 'string' || action.failure.length === 0) throw new TypeError('completion action is invalid');
      try { await action.perform(); }
      catch (error) { reasons.push(`${action.failure}: ${boundedReason(error)}`); }
    }
    return reasons.length === 0 ? null : reasons.join('; ');
  };
  return Object.freeze({ run });
}
