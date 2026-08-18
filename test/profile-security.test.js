import test from 'node:test';
import assert from 'node:assert/strict';
import { profileSecurityDescription, enforcementProviderReport } from '../src/runtime/profile-security.js';
import { verifiedBubblewrapStatus } from '../src/runtime/sandbox-status.js';

function profile(overrides = {}) {
  return {
    name: 'fixture',
    sandbox: {
      enforcement: 'os',
      outsideProjectRead: 'deny',
      outsideProjectWrite: false,
      network: 'deny',
      ...overrides,
    },
  };
}

test('an os declaration alone never produces verified or usable enforcement', () => {
  const result = profileSecurityDescription(profile(), {
    requestedProvider: 'auto',
    provider: 'bubblewrap',
    platform: process.platform,
    available: true,
    verified: false,
    verification: 'not-probed',
    filesystem: 'unverified',
    network: 'unverified',
    gitAdministrativeState: 'unverified',
    processTree: 'unverified',
    reason: null,
    boundaryProbe: { attempted: false, verified: false, observations: null },
  });
  assert.equal(result.declaredPolicy.toolEnforcement, 'os');
  assert.equal(result.enforcement.verified, false);
  assert.equal(result.enforcement.usable, false);
  assert.equal(result.enforcement.verification, 'not-probed');
});

test('verified provider evidence is reported separately from the tool declaration', () => {
  const provider = verifiedBubblewrapStatus({ requestedProvider: 'auto' });
  const result = profileSecurityDescription(profile({ enforcement: 'none' }), provider);
  assert.equal(result.declaredPolicy.toolEnforcement, 'none');
  assert.equal(result.enforcement.provider, 'bubblewrap');
  assert.equal(result.enforcement.verified, true);
  assert.equal(result.enforcement.usable, true);
  assert.equal(result.enforcement.boundaryProbe.verified, true);
  assert.equal(result.enforcement.boundaryProbe.observations.arbitraryOutsideReadDenied, true);
  assert.equal(result.enforcement.boundaryProbe.observations.arbitraryOutsideWriteDenied, true);
  assert.equal(result.enforcement.boundaryProbe.observations.networkEgressDenied, true);
});

test('unsupported requested capability remains unusable even with a verified provider', () => {
  const provider = verifiedBubblewrapStatus({ requestedProvider: 'auto' });
  const restricted = profileSecurityDescription(profile({ network: 'restricted' }), provider);
  assert.equal(restricted.enforcement.verified, true);
  assert.equal(restricted.enforcement.usable, false);
  assert.equal(restricted.enforcement.network, 'unsupported-request');
  assert.match(restricted.enforcement.reason, /restricted network mode/u);

  const outsideWrite = profileSecurityDescription(profile({ outsideProjectWrite: true }), provider);
  assert.equal(outsideWrite.enforcement.verified, true);
  assert.equal(outsideWrite.enforcement.usable, false);
  assert.match(outsideWrite.enforcement.reason, /writes outside/u);
});

test('failed boundary-probe status is represented as attempted but unverified', () => {
  const reported = enforcementProviderReport({
    requestedProvider: 'bubblewrap',
    provider: 'bubblewrap',
    platform: 'linux',
    available: true,
    verified: false,
    verification: 'boundary-probe-failed',
    repositoryCodeExecution: false,
    filesystem: 'unenforced',
    network: 'unenforced',
    gitAdministrativeState: 'unenforced',
    processTree: 'managed-by-parent-runner',
    boundaryProbe: { attempted: false, verified: false, observations: null },
    reason: 'fixture failure',
  });
  assert.equal(reported.boundaryProbe.attempted, true);
  assert.equal(reported.boundaryProbe.verified, false);
  assert.equal(reported.verified, false);
});
