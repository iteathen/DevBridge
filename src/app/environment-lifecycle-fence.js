const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

export function createEnvironmentLifecycleFence({
  admission,
} = {}) {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission) || typeof admission.acquire !== 'function') {
    throw new TypeError('environment lifecycle fence admission contract is incomplete');
  }

  return Object.freeze({
    async acquire(raw = {}) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('environment lifecycle fence request is invalid');
      for (const key of Object.keys(raw)) if (!['subject', 'operationId'].includes(key)) throw new TypeError('environment lifecycle fence request contains an unknown field');
      const subject = safeId(raw.subject, 'environment lifecycle fence subject');
      const operationId = safeId(raw.operationId, 'environment lifecycle fence operationId');
      const held = await admission.acquire(Object.freeze({ subject, operationId }));
      if (!held || typeof held !== 'object' || Array.isArray(held)
          || held.subject !== subject || typeof held.release !== 'function') {
        throw new Error('environment lifecycle fence admission evidence is invalid');
      }
      return Object.freeze({ subject, release: held.release.bind(held) });
    },
  });
}
