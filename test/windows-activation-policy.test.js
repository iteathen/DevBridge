import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOWS_ACTIVATION_POLICY_PROTOCOL,
  createConfigureLaterWindowsActivationPolicy,
  normalizeWindowsActivationPolicy,
  windowsActivationPolicySubject,
} from '../src/setup/windows-activation-policy.js';

test('configure-later policy is strict, non-secret, and deterministically addressed', () => {
  const policy = createConfigureLaterWindowsActivationPolicy();
  assert.deepEqual(policy, {
    protocol: WINDOWS_ACTIVATION_POLICY_PROTOCOL,
    mode: 'configure-later',
  });
  assert.match(windowsActivationPolicySubject(policy), /^subject-[a-f0-9]{32}$/u);
  assert.equal(windowsActivationPolicySubject({ mode: 'configure-later', protocol: WINDOWS_ACTIVATION_POLICY_PROTOCOL }), windowsActivationPolicySubject(policy));
  for (const extra of [
    { productKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' },
    { credential: 'secret' },
    { service: 'external-identity' },
    { hostEntitlement: true },
  ]) {
    assert.throws(() => normalizeWindowsActivationPolicy({ ...policy, ...extra }), /is not allowed/u);
  }
});

test('policy rejects undeclared activation methods', () => {
  for (const mode of ['retail', 'mak', 'kms', 'active-directory', 'subscription', 'host']) {
    assert.throws(() => normalizeWindowsActivationPolicy({
      protocol: WINDOWS_ACTIVATION_POLICY_PROTOCOL,
      mode,
    }), /mode is unsupported/u);
  }
});
