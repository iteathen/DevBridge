import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { normalizeCoordinationConfig } from '../src/config/coordination-config.js';

function publicKeySpki() {
  const { publicKey } = generateKeyPairSync('ed25519');
  return Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
}

test('coordination is disabled by default with bounded local lease timing', () => {
  const config = normalizeCoordinationConfig({}, { pollIntervalMs: 60_000 });
  assert.equal(config.enabled, false);
  assert.equal(config.handle, 'agent');
  assert.equal(config.leaseTtlMs, 1_200_000);
  assert.equal(config.heartbeatIntervalMs, 300_000);
  assert.equal(config.clockSkewMs, 60_000);
  assert.deepEqual(config.trustedPeers, []);
});

test('trusted peers are cryptographically validated and projected without private authority', () => {
  const config = normalizeCoordinationConfig({
    enabled: true,
    handle: 'workstation-a',
    trustedPeers: [{ handle: 'workstation-b', publicKeySpki: publicKeySpki() }],
  }, { pollIntervalMs: 60_000 });
  assert.equal(config.trustedPeers.length, 1);
  assert.match(config.trustedPeers[0].fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(config.trustedPeers[0].address, `workstation-b#${config.trustedPeers[0].fingerprint}`);
  assert.equal(JSON.stringify(config).includes('private'), false);
});

test('coordination rejects unknown authority fields, duplicate peers, and unsafe lease timing', () => {
  assert.throws(
    () => normalizeCoordinationConfig({ leaseRef: 'refs/heads/attacker' }),
    /coordination\.leaseRef is not supported/u,
  );
  assert.throws(
    () => normalizeCoordinationConfig({ expectedSha: 'a'.repeat(40) }),
    /coordination\.expectedSha is not supported/u,
  );
  assert.throws(
    () => normalizeCoordinationConfig({ enabled: true, leaseTtlMs: 120_000, heartbeatIntervalMs: 60_000, clockSkewMs: 60_000 }, { pollIntervalMs: 60_000 }),
    /cover at least two normal poll intervals plus clock skew/u,
  );
  assert.throws(
    () => normalizeCoordinationConfig({ leaseTtlMs: 120_000, heartbeatIntervalMs: 70_000 }),
    /at least twice/u,
  );

  const key = publicKeySpki();
  assert.throws(
    () => normalizeCoordinationConfig({ trustedPeers: [
      { handle: 'one', publicKeySpki: key },
      { handle: 'one', publicKeySpki: key },
    ] }),
    /duplicates fingerprint/u,
  );
});
