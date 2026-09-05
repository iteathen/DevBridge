import assert from 'node:assert/strict';
import test from 'node:test';
import { observeLinuxCliAuthenticationOrigin } from '../src/setup/linux-cli-authentication-origin.js';

function ports(environment = {}) {
  return {
    readPlatform: async () => 'linux',
    readEffectiveIdentityId: async () => 0,
    readEnvironment: async () => environment,
  };
}

test('authenticated origin projects only the exact submitting local principal', async () => {
  const environment = Object.freeze({
    SUDO_USER: 'local-user',
    SUDO_UID: '1001',
    SUDO_GID: '1002',
    GH_TOKEN: 'must-not-cross',
    HOME: '/root',
  });
  const result = await observeLinuxCliAuthenticationOrigin({}, ports(environment));
  assert.deepEqual(result, {
    principal: { name: 'local-user', identityId: 1001, primaryCapabilityId: 1002 },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.principal), true);
  assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
  assert.equal(JSON.stringify(result).includes('/root'), false);
});

test('authenticated origin requires Linux effective root invocation', async () => {
  await assert.rejects(observeLinuxCliAuthenticationOrigin({}, {
    ...ports({ SUDO_USER: 'alice', SUDO_UID: '1000', SUDO_GID: '1000' }),
    readPlatform: async () => 'win32',
  }), /invocation is invalid/u);
  await assert.rejects(observeLinuxCliAuthenticationOrigin({}, {
    ...ports({ SUDO_USER: 'alice', SUDO_UID: '1000', SUDO_GID: '1000' }),
    readEffectiveIdentityId: async () => 1000,
  }), /invocation is invalid/u);
});

test('authenticated origin rejects malformed, root, missing, or widened evidence', async () => {
  const cases = [
    {},
    { SUDO_USER: 'root', SUDO_UID: '1000', SUDO_GID: '1000' },
    { SUDO_USER: 'alice', SUDO_UID: '0', SUDO_GID: '1000' },
    { SUDO_USER: 'alice', SUDO_UID: '01', SUDO_GID: '1000' },
    { SUDO_USER: 'alice', SUDO_UID: '1000', SUDO_GID: '4294967295' },
    { SUDO_USER: '../alice', SUDO_UID: '1000', SUDO_GID: '1000' },
  ];
  for (const evidence of cases) {
    await assert.rejects(observeLinuxCliAuthenticationOrigin({}, ports(evidence)));
  }
});

test('authenticated origin contract and ports are exact', async () => {
  await assert.rejects(observeLinuxCliAuthenticationOrigin({ action: 'foreign' }, ports()), /unknown field/u);
  await assert.rejects(observeLinuxCliAuthenticationOrigin({}, { ...ports(), lookup: async () => null }), /unknown field/u);
});
