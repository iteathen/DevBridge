import { createHash } from 'node:crypto';

export const IMAGE_DISTRIBUTION_POLICY_PROTOCOL = 'devbridge/image-distribution-policy-v1';

const MODES = new Set(['local-reconstruction']);

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

export function normalizeImageDistributionPolicy(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'mode']), 'image distribution policy');
  if (value.protocol !== IMAGE_DISTRIBUTION_POLICY_PROTOCOL) throw new TypeError('image distribution policy protocol is unsupported');
  if (typeof value.mode !== 'string' || !MODES.has(value.mode)) throw new TypeError('image distribution policy mode is unsupported');
  return Object.freeze({ protocol: IMAGE_DISTRIBUTION_POLICY_PROTOCOL, mode: value.mode });
}

export function imageDistributionPolicySubject(raw) {
  const policy = normalizeImageDistributionPolicy(raw);
  return `subject-${createHash('sha256').update(JSON.stringify(policy), 'utf8').digest('hex').slice(0, 32)}`;
}

export function createLocalReconstructionImageDistributionPolicy() {
  return normalizeImageDistributionPolicy({
    protocol: IMAGE_DISTRIBUTION_POLICY_PROTOCOL,
    mode: 'local-reconstruction',
  });
}
