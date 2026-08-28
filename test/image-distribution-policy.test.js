import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_DISTRIBUTION_POLICY_PROTOCOL,
  createLocalReconstructionImageDistributionPolicy,
  imageDistributionPolicySubject,
  normalizeImageDistributionPolicy,
} from '../src/setup/image-distribution-policy.js';

test('local reconstruction policy is strict and deterministically addressed', () => {
  const policy = createLocalReconstructionImageDistributionPolicy();
  assert.deepEqual(policy, {
    protocol: IMAGE_DISTRIBUTION_POLICY_PROTOCOL,
    mode: 'local-reconstruction',
  });
  assert.match(imageDistributionPolicySubject(policy), /^subject-[a-f0-9]{32}$/u);
  assert.equal(imageDistributionPolicySubject({ mode: 'local-reconstruction', protocol: IMAGE_DISTRIBUTION_POLICY_PROTOCOL }), imageDistributionPolicySubject(policy));
  for (const extra of [
    { repository: 'owner/images' },
    { url: 'https://example.invalid' },
    { credential: 'secret' },
    { path: 'local-file' },
    { provider: 'external' },
  ]) {
    assert.throws(() => normalizeImageDistributionPolicy({ ...policy, ...extra }), /is not allowed/u);
  }
});

test('policy rejects undeclared storage and transfer modes', () => {
  for (const mode of ['remote-artifact', 'private-release', 'upload', 'mirror', 'cache-only']) {
    assert.throws(() => normalizeImageDistributionPolicy({
      protocol: IMAGE_DISTRIBUTION_POLICY_PROTOCOL,
      mode,
    }), /mode is unsupported/u);
  }
});
