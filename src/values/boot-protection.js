const CONTRACT = Object.freeze({ integrity: 'required', identity: 'required', trust: 'platform-owner' });

export function requiredBootProtection() {
  return Object.freeze({ ...CONTRACT });
}

export function normalizeBootProtection(raw, { optional = false, name = 'boot protection' } = {}) {
  if (raw == null && optional) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!Object.hasOwn(CONTRACT, key)) throw new TypeError(`${name}.${key} is not allowed`);
  for (const [key, expected] of Object.entries(CONTRACT)) if (raw[key] !== expected) throw new TypeError(`${name}.${key} is invalid`);
  return { ...CONTRACT };
}
