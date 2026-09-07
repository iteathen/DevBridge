import { createHash } from 'node:crypto';

export const WINDOWS_ACTIVATION_POLICY_PROTOCOL = 'devbridge/windows-activation-policy-v1';

const MODES = new Set(['configure-later']);

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

export function normalizeWindowsActivationPolicy(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'mode']), 'activation policy');
  if (value.protocol !== WINDOWS_ACTIVATION_POLICY_PROTOCOL) throw new TypeError('activation policy protocol is unsupported');
  if (typeof value.mode !== 'string' || !MODES.has(value.mode)) throw new TypeError('activation policy mode is unsupported');
  return Object.freeze({ protocol: WINDOWS_ACTIVATION_POLICY_PROTOCOL, mode: value.mode });
}

export function windowsActivationPolicySubject(raw) {
  const policy = normalizeWindowsActivationPolicy(raw);
  return `subject-${createHash('sha256').update(JSON.stringify(policy), 'utf8').digest('hex').slice(0, 32)}`;
}

export function createConfigureLaterWindowsActivationPolicy() {
  return normalizeWindowsActivationPolicy({
    protocol: WINDOWS_ACTIVATION_POLICY_PROTOCOL,
    mode: 'configure-later',
  });
}
