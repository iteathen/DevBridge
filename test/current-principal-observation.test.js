import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import test from 'node:test';
import {
  CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL,
  observeCurrentPrincipal,
} from '../src/setup/current-principal-observation.js';
import { observeLocalPrincipal } from '../src/setup/local-principal-observation.js';

function ports(overrides = {}) {
  return {
    readRecord: async () => ({ name: 'local-user', identityId: 1001, primaryCapabilityId: 1002 }),
    readRealIdentityId: async () => 1001,
    readEffectiveIdentityId: async () => 1001,
    readRealPrimaryCapabilityId: async () => 1002,
    readEffectivePrimaryCapabilityId: async () => 1002,
    ...overrides,
  };
}

test('current principal observation projects one exact neutral non-root identity', async () => {
  const observed = await observeCurrentPrincipal({}, ports());
  assert.deepEqual(observed, {
    protocol: CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL,
    ready: true,
    principal: { name: 'local-user', identityId: 1001, primaryCapabilityId: 1002 },
    reason: null,
  });
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.principal), true);
});

test('current principal observation rejects root, credential drift, and malformed evidence without leaking it', async () => {
  const cases = [
    ['evidence-invalid', { readRecord: async () => ({ name: 'root', identityId: 0, primaryCapabilityId: 0 }) }],
    ['identity-mismatch', { readEffectiveIdentityId: async () => 1003 }],
    ['identity-mismatch', { readRealPrimaryCapabilityId: async () => 1004 }],
    ['evidence-invalid', { readRecord: async () => ({ name: '../foreign', identityId: 1001, primaryCapabilityId: 1002 }) }],
    ['evidence-invalid', { readRecord: async () => ({ name: 'local-user', identityId: 1001, primaryCapabilityId: 1002, path: '/private' }) }],
    ['observation-unavailable', { readRecord: async () => { throw new Error('/private'); } }],
  ];
  for (const [reason, replacement] of cases) {
    const observed = await observeCurrentPrincipal({}, ports(replacement));
    assert.deepEqual(observed, {
      protocol: CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL,
      ready: false,
      principal: null,
      reason,
    });
    assert.equal(JSON.stringify(observed).includes('private'), false);
  }
});

test('current principal contracts reject widened, symbolic, hidden, and accessor-shaped input', async () => {
  await assert.rejects(observeCurrentPrincipal({ platform: 'linux' }, ports()), /unknown field|invalid/u);
  await assert.rejects(observeCurrentPrincipal({}, { ...ports(), fallback: async () => null }), /invalid|unknown field/u);

  const symbolic = ports();
  symbolic[Symbol('foreign')] = async () => null;
  await assert.rejects(observeCurrentPrincipal({}, symbolic), /invalid/u);

  const hidden = ports();
  Object.defineProperty(hidden, 'foreign', { value: async () => null });
  await assert.rejects(observeCurrentPrincipal({}, hidden), /invalid/u);

  const record = { name: 'local-user', identityId: 1001 };
  Object.defineProperty(record, 'primaryCapabilityId', { enumerable: true, get: () => 1002 });
  assert.equal((await observeCurrentPrincipal({}, ports({ readRecord: async () => record }))).reason, 'evidence-invalid');
});

test('production local principal observation executes as a read-only Ubuntu canary', {
  skip: process.platform !== 'linux' || process.getuid?.() === 0,
}, async () => {
  const observed = await observeLocalPrincipal();
  assert.equal(observed.protocol, CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL);
  assert.equal(observed.ready, true);
  assert.match(observed.principal.name, /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u);
  assert.equal(observed.principal.identityId, process.getuid());
  assert.equal(observed.principal.primaryCapabilityId, process.getgid());
});

test('principal policy is import-free and neither principal module consumes ambient identity text', async () => {
  const policy = (await readFile(new URL('../src/setup/current-principal-observation.js', import.meta.url), 'utf8')).toLowerCase();
  const adapter = (await readFile(new URL('../src/setup/local-principal-observation.js', import.meta.url), 'utf8')).toLowerCase();
  assert.equal(/^import\s/mu.test(policy), false);
  for (const source of [policy, adapter]) {
    for (const identity of ['github', 'sudo_user', 'process.env', 'credential', 'provider', 'repository', 'virtual-machine']) {
      assert.equal(source.includes(identity), false, identity);
    }
  }
});
