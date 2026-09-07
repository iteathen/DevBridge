const MAX_ACTIONS = 64;

function descriptor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof raw.protocol !== 'string' || raw.protocol.length < 1 || raw.protocol.length > 256) {
    throw new TypeError('exact action descriptor is invalid');
  }
  return raw;
}

export function createExactActionRouter({ actions } = {}) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_ACTIONS) {
    throw new TypeError('exact action registrations are invalid');
  }
  const routes = new Map(actions.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.protocol !== 'string' || entry.protocol.length < 1 || entry.protocol.length > 256
        || !entry.action || typeof entry.action.observe !== 'function' || typeof entry.action.remove !== 'function') {
      throw new TypeError(`exact action registration ${index} is invalid`);
    }
    return [entry.protocol, entry.action];
  }));
  if (routes.size !== actions.length) throw new TypeError('exact action registrations contain duplicate protocols');

  function route(raw) {
    const value = descriptor(raw);
    const action = routes.get(value.protocol);
    if (!action) throw new Error('exact action protocol is unavailable');
    return Object.freeze({ action, value });
  }

  return Object.freeze({
    observe(raw) {
      const selected = route(raw);
      return selected.action.observe(structuredClone(selected.value));
    },
    remove(raw) {
      const selected = route(raw);
      return selected.action.remove(structuredClone(selected.value));
    },
  });
}
