import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
  environmentActivityRouteForSubject,
  loadEnvironmentActivityPolicy,
  normalizeEnvironmentActivityPolicy,
  publishEnvironmentActivityPolicy,
  validationEnvironmentActivityRoute,
} from '../src/runtime/environment-activity-policy.js';

function policy(routes) { return { protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes }; }

test('activity policy is credential-free and admits only stable subject/profile selection', () => {
  const value = normalizeEnvironmentActivityPolicy(policy([{ subject: '42', profile: 'linux-development', preferred: true, validation: true }]));
  assert.deepEqual(value.routes[0], { subject: '42', profile: 'linux-development', preferred: true, validation: true });
  for (const [name, entry] of [['access', { family: 'linux' }], ['identityFile', 'C:/secret'], ['provider', 'hyperv'], ['environment', 'env-a']]) {
    assert.throws(() => normalizeEnvironmentActivityPolicy(policy([{ subject: '42', profile: 'linux-development', [name]: entry }])), new RegExp(`${name} is not allowed`, 'u'));
  }
  assert.throws(() => normalizeEnvironmentActivityPolicy(policy([{ subject: 'owner/name', profile: 'linux' }])), /numeric stable identity/u);
});

test('activity policy selects one preferred and one validation route', () => {
  const value = policy([
    { subject: '42', profile: 'linux', preferred: true, validation: true },
    { subject: '42', profile: 'windows' },
  ]);
  assert.equal(environmentActivityRouteForSubject(value, '42').profile, 'linux');
  assert.equal(validationEnvironmentActivityRoute(value).profile, 'linux');
  assert.throws(() => normalizeEnvironmentActivityPolicy(policy([
    { subject: '1', profile: 'linux', validation: true },
    { subject: '2', profile: 'windows', validation: true },
  ])), /multiple validation routes/u);
});

test('activity policy publishes atomically and missing policy remains explicit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-activity-policy-'));
  try {
    assert.equal(await loadEnvironmentActivityPolicy(root), null);
    const expected = policy([{ subject: '42', profile: 'linux', preferred: true, validation: false }]);
    await publishEnvironmentActivityPolicy(root, expected);
    assert.deepEqual(await loadEnvironmentActivityPolicy(root), normalizeEnvironmentActivityPolicy(expected));
  } finally { await rm(root, { recursive: true, force: true }); }
});

