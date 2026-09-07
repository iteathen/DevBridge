const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const MAX_REASON = 512;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function identifiers(raw, name) {
  if (!Array.isArray(raw) || raw.length > 1_024) throw new TypeError(`${name} is invalid`);
  const values = raw.map((value, index) => identifier(value, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze(values);
}

function reason(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_REASON || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function observations(raw, selected) {
  if (!Array.isArray(raw) || raw.length > selected.size) throw new TypeError('serial action observations are invalid');
  const values = new Map();
  raw.forEach((entry, index) => {
    const value = exactObject(entry, new Set(['profile', 'complete', 'blocked', 'reason']), `serial action observations[${index}]`);
    const profile = identifier(value.profile, `serial action observations[${index}].profile`);
    if (!selected.has(profile) || values.has(profile)) throw new TypeError('serial action observation profile is invalid');
    if (typeof value.complete !== 'boolean' || typeof value.blocked !== 'boolean' || (value.complete && value.blocked)) {
      throw new TypeError('serial action observation state is invalid');
    }
    const selectedReason = value.reason == null ? null : reason(value.reason, `serial action observations[${index}].reason`);
    if (value.blocked !== (selectedReason != null)) throw new TypeError('serial action observation blocker is inconsistent');
    values.set(profile, Object.freeze({ profile, complete: value.complete, blocked: value.blocked, reason: selectedReason }));
  });
  return values;
}

function result(state, profile = null, selectedReason = null) {
  return Object.freeze({ state, profile, reason: selectedReason });
}

export function selectSerialProfileAction(input = {}, policy = {}) {
  const selectedInput = exactObject(input, new Set(['profiles', 'observations']), 'serial action input');
  const selectedPolicy = exactObject(policy, new Set(['order']), 'serial action policy');
  const profiles = identifiers(selectedInput.profiles, 'serial action profiles');
  const order = identifiers(selectedPolicy.order, 'serial action order');
  const selected = new Set(profiles);
  if (profiles.some((profile) => !order.includes(profile))) throw new TypeError('serial action order does not cover every selected profile');
  const observed = observations(selectedInput.observations, selected);

  for (const profile of order) {
    if (!selected.has(profile)) continue;
    const status = observed.get(profile);
    if (!status) return result('blocked', profile, 'selected profile observation is unavailable');
    if (status.complete) continue;
    if (status.blocked) return result('blocked', profile, status.reason);
    return result('ready', profile);
  }
  return result('complete');
}
