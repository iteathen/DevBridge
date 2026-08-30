import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExclusivePhysicalDevices } from '../src/runtime/exclusive-physical-devices.js';
import {
  EXCLUSIVE_PHYSICAL_DEVICE_AUTHORITY_REQUEST_PROTOCOL,
  EXCLUSIVE_PHYSICAL_DEVICE_AUTHORITY_RESULT_PROTOCOL,
  ExclusivePhysicalDeviceAuthorityClient,
  createExclusivePhysicalDeviceAuthorityMutationHandler,
  createExclusivePhysicalDeviceAuthorityReadHandler,
  normalizeExclusivePhysicalDeviceAuthorityRequest,
  normalizeExclusivePhysicalDeviceAuthorityResult,
} from '../src/runtime/exclusive-physical-device-authority-protocol.js';

const SUBJECT = 'device-primary-accelerator';
const DEVICE_GENERATION = 'device-gen-1';
const ENVIRONMENT = Object.freeze({ identity: 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', generation: '7' });
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function sampleClaim() {
  return {
    id: 'claim-11111111111111111111111111111111',
    subject: SUBJECT,
    deviceGeneration: DEVICE_GENERATION,
    environment: structuredClone(ENVIRONMENT),
    preparationGeneration: 'prep-1',
    assignmentGeneration: 'assignment-1',
    qualificationGeneration: 'qualification-1',
    claimedAt: '2026-08-30T14:00:00.000Z',
  };
}

function sampleStatus(state = 'AVAILABLE', claim = null) {
  const owned = state === 'OWNED';
  return {
    subject: SUBJECT,
    deviceGeneration: DEVICE_GENERATION,
    state,
    capabilities: ['exclusive-accelerator'],
    claim,
    provider: {
      state: owned ? 'owned' : 'available',
      rootSafe: !owned,
      owner: owned ? structuredClone(ENVIRONMENT) : null,
      assignmentGeneration: owned ? 'assignment-1' : null,
      reason: null,
    },
    reason: null,
  };
}

function request(operation, payload, requestId = REQUEST_ID) {
  return {
    protocol: EXCLUSIVE_PHYSICAL_DEVICE_AUTHORITY_REQUEST_PROTOCOL,
    requestId,
    operation,
    payload,
  };
}

test('protected protocol exposes only the high-level physical-device semantic studs', async () => {
  let claimCalls = 0;
  let releaseCalls = 0;
  let reconcileCalls = 0;
  const authority = {
    async observe(subject) {
      assert.equal(subject, SUBJECT);
      return sampleStatus();
    },
    async claim(subject, environment) {
      assert.equal(subject, SUBJECT);
      assert.deepEqual(environment, ENVIRONMENT);
      claimCalls += 1;
      return sampleStatus('OWNED', sampleClaim());
    },
    async release(claim) {
      assert.deepEqual(claim, sampleClaim());
      releaseCalls += 1;
      return {
        ...sampleStatus(),
        releasedClaimId: claim.id,
        formerOwnerPreparationReady: true,
        formerOwnerPreparationGeneration: 'prep-1',
      };
    },
    async reconcile(subject) {
      assert.equal(subject, SUBJECT);
      reconcileCalls += 1;
      return sampleStatus();
    },
  };
  const read = createExclusivePhysicalDeviceAuthorityReadHandler({ authority });
  const mutation = createExclusivePhysicalDeviceAuthorityMutationHandler({ authority });

  const forbiddenReadMutation = await read(request('claim', { subject: SUBJECT, environment: ENVIRONMENT }));
  assert.equal(forbiddenReadMutation.ok, false);
  assert.equal(forbiddenReadMutation.error.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(claimCalls, 0);

  const forbiddenMutationRead = await mutation(request('observe', { subject: SUBJECT }));
  assert.equal(forbiddenMutationRead.ok, false);
  assert.equal(forbiddenMutationRead.error.code, 'OPERATION_NOT_ALLOWED');

  const client = new ExclusivePhysicalDeviceAuthorityClient({ readExchange: read, mutationExchange: mutation });
  assert.equal((await client.observe(SUBJECT)).state, 'AVAILABLE');
  const claimed = await client.claim(SUBJECT, ENVIRONMENT);
  assert.equal(claimed.state, 'OWNED');
  assert.equal(claimCalls, 1);
  const released = await client.release(claimed.claim);
  assert.equal(released.state, 'AVAILABLE');
  assert.equal(releaseCalls, 1);
  assert.equal((await client.reconcile(SUBJECT)).state, 'AVAILABLE');
  assert.equal(reconcileCalls, 1);
});

test('protected protocol rejects lower-level provider mutation fields', () => {
  assert.throws(() => normalizeExclusivePhysicalDeviceAuthorityRequest(request('claim', {
    subject: SUBJECT,
    environment: ENVIRONMENT,
    deviceGeneration: DEVICE_GENERATION,
  })), /not allowed/u);
  assert.throws(() => normalizeExclusivePhysicalDeviceAuthorityRequest(request('claim', {
    subject: SUBJECT,
    environment: ENVIRONMENT,
    pciAddress: 'opaque-provider-detail',
  })), /not allowed/u);
  assert.throws(() => normalizeExclusivePhysicalDeviceAuthorityRequest(request('release', {
    claim: sampleClaim(),
    command: 'opaque-provider-operation',
  })), /not allowed/u);
});

test('protected protocol binds successful results to the exact requested subject', () => {
  const expected = request('observe', { subject: SUBJECT });
  assert.throws(() => normalizeExclusivePhysicalDeviceAuthorityResult({
    protocol: EXCLUSIVE_PHYSICAL_DEVICE_AUTHORITY_RESULT_PROTOCOL,
    requestId: REQUEST_ID,
    ok: true,
    value: { ...sampleStatus(), subject: 'device-other' },
  }, expected), /result subject changed/u);
});

test('client fails closed on transport loss and result ownership mismatch', async () => {
  const unavailable = new ExclusivePhysicalDeviceAuthorityClient({
    readExchange: async () => { throw new Error('transport detail'); },
    mutationExchange: async () => { throw new Error('transport detail'); },
  });
  await assert.rejects(unavailable.observe(SUBJECT), /authority is unavailable/u);

  const mismatched = new ExclusivePhysicalDeviceAuthorityClient({
    readExchange: async () => ({
      protocol: EXCLUSIVE_PHYSICAL_DEVICE_AUTHORITY_RESULT_PROTOCOL,
      requestId: '22222222-2222-4222-8222-222222222222',
      ok: true,
      value: sampleStatus(),
    }),
    mutationExchange: async () => { throw new Error('unused'); },
  });
  await assert.rejects(mismatched.observe(SUBJECT), /ownership proof is invalid/u);
});

function integrationFixture() {
  let failAfterClaimEffect = false;
  let failAfterReleaseEffect = false;
  let claimCalls = 0;
  let releaseCalls = 0;
  let qualificationCalls = 0;
  let observation = {
    subject: SUBJECT,
    deviceGeneration: DEVICE_GENERATION,
    state: 'available',
    rootSafe: true,
    owner: null,
    assignmentGeneration: null,
    reason: null,
  };

  const inventory = {
    async resolve(subject) {
      return {
        subject,
        generation: DEVICE_GENERATION,
        eligible: true,
        critical: false,
        capabilities: ['exclusive-accelerator'],
        reason: null,
      };
    },
  };
  const environments = {
    async observe(environment) {
      return { ...environment, admitted: true, reason: null };
    },
  };
  const preparation = {
    async observe(environment) {
      return { ...environment, ready: true, preparationGeneration: 'prep-1', reason: null };
    },
  };
  const assignment = {
    async observe(subject) {
      assert.equal(subject, SUBJECT);
      return structuredClone(observation);
    },
    async claim({ subject, deviceGeneration, environment }) {
      assert.equal(subject, SUBJECT);
      assert.equal(deviceGeneration, DEVICE_GENERATION);
      claimCalls += 1;
      observation = {
        subject,
        deviceGeneration,
        state: 'owned',
        rootSafe: false,
        owner: structuredClone(environment),
        assignmentGeneration: `assignment-${claimCalls}`,
        reason: null,
      };
      if (failAfterClaimEffect) {
        failAfterClaimEffect = false;
        throw new Error('provider response lost after claim effect');
      }
    },
    async release({ subject, deviceGeneration, environment, assignmentGeneration }) {
      assert.equal(subject, SUBJECT);
      assert.equal(deviceGeneration, DEVICE_GENERATION);
      assert.deepEqual(environment, observation.owner);
      assert.equal(assignmentGeneration, observation.assignmentGeneration);
      releaseCalls += 1;
      observation = {
        subject,
        deviceGeneration,
        state: 'available',
        rootSafe: true,
        owner: null,
        assignmentGeneration: null,
        reason: null,
      };
      if (failAfterReleaseEffect) {
        failAfterReleaseEffect = false;
        throw new Error('provider response lost after release effect');
      }
    },
  };
  const guestLifecycle = {
    async quiesce({ environment }) {
      return { ...environment, quiesced: true, environmentStopped: true, reason: null };
    },
    async rebind({ environment }) {
      return { ...environment, ready: true, environmentRestarted: true, reason: null };
    },
  };
  const qualification = {
    async qualify({ environment }) {
      qualificationCalls += 1;
      return {
        ...environment,
        qualified: true,
        qualificationGeneration: `qualification-${qualificationCalls}`,
        reason: null,
      };
    },
  };

  return {
    inventory,
    environments,
    preparation,
    assignment,
    guestLifecycle,
    qualification,
    failNextClaimAfterEffect() { failAfterClaimEffect = true; },
    failNextReleaseAfterEffect() { failAfterReleaseEffect = true; },
    claimCalls() { return claimCalls; },
    releaseCalls() { return releaseCalls; },
    qualificationCalls() { return qualificationCalls; },
    observation() { return structuredClone(observation); },
  };
}

function semanticAuthority(directory, fake) {
  return new ExclusivePhysicalDevices({
    directory,
    inventory: fake.inventory,
    environments: fake.environments,
    assignment: fake.assignment,
    preparation: fake.preparation,
    guestLifecycle: fake.guestLifecycle,
    qualification: fake.qualification,
  });
}

function protectedClient(authority, mutationWrapper = null) {
  const read = createExclusivePhysicalDeviceAuthorityReadHandler({ authority });
  const mutation = createExclusivePhysicalDeviceAuthorityMutationHandler({ authority });
  return new ExclusivePhysicalDeviceAuthorityClient({
    readExchange: read,
    mutationExchange: mutationWrapper ? (requestValue) => mutationWrapper(mutation, requestValue) : mutation,
  });
}

async function withIntegrationFixture(prefix, work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const fake = integrationFixture();
  try { await work(directory, fake); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('protected semantic authority reconciles a lost provider claim result without duplicate effect', async () => {
  await withIntegrationFixture('db-protected-semantic-claim-', async (directory, fake) => {
    fake.failNextClaimAfterEffect();
    let authority = semanticAuthority(directory, fake);
    let client = protectedClient(authority);

    await assert.rejects(client.claim(SUBJECT, ENVIRONMENT), /operation failed/u);
    assert.equal(fake.claimCalls(), 1);
    assert.equal(fake.observation().state, 'owned');

    authority = semanticAuthority(directory, fake);
    client = protectedClient(authority);
    const reconciled = await client.reconcile(SUBJECT);
    assert.equal(reconciled.state, 'OWNED');
    assert.deepEqual(reconciled.claim.environment, ENVIRONMENT);
    assert.equal(fake.claimCalls(), 1);
    assert.equal(fake.qualificationCalls(), 1);
  });
});

test('protected semantic authority reconciles a lost provider release result without duplicate effect', async () => {
  await withIntegrationFixture('db-protected-semantic-release-', async (directory, fake) => {
    let authority = semanticAuthority(directory, fake);
    let client = protectedClient(authority);
    const claimed = await client.claim(SUBJECT, ENVIRONMENT);
    assert.equal(fake.claimCalls(), 1);

    fake.failNextReleaseAfterEffect();
    await assert.rejects(client.release(claimed.claim), /operation failed/u);
    assert.equal(fake.releaseCalls(), 1);
    assert.equal(fake.observation().state, 'available');
    assert.equal(fake.observation().rootSafe, true);

    authority = semanticAuthority(directory, fake);
    client = protectedClient(authority);
    const reconciled = await client.reconcile(SUBJECT);
    assert.equal(reconciled.state, 'AVAILABLE');
    assert.equal(reconciled.claim, null);
    assert.equal(fake.releaseCalls(), 1);
  });
});

test('lost outer transport response cannot turn a completed protected claim into a duplicate provider claim', async () => {
  await withIntegrationFixture('db-protected-transport-claim-', async (directory, fake) => {
    const authority = semanticAuthority(directory, fake);
    let dropClaimResult = true;
    const client = protectedClient(authority, async (mutation, requestValue) => {
      const result = await mutation(requestValue);
      if (dropClaimResult && requestValue.operation === 'claim') {
        dropClaimResult = false;
        throw new Error('simulated transport loss after protected operation completed');
      }
      return result;
    });

    await assert.rejects(client.claim(SUBJECT, ENVIRONMENT), /authority is unavailable/u);
    assert.equal(fake.claimCalls(), 1);
    const observed = await client.observe(SUBJECT);
    assert.equal(observed.state, 'OWNED');
    await assert.rejects(client.claim(SUBJECT, ENVIRONMENT), /operation failed/u);
    assert.equal(fake.claimCalls(), 1);
  });
});

test('protected authority protocol remains provider-specific-identity free', async () => {
  const source = await readFile(path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/runtime/exclusive-physical-device-authority-protocol.js',
  ), 'utf8');
  for (const forbidden of [
    /\bPCI(?:e)?\b/u,
    /\bPnP\b/u,
    /\bWHP\b/u,
    /\bVPCI\b/u,
    /\bHyper-V\b/u,
    /\blibvirt\b/u,
    /\bVFIO\b/u,
    /\bIOMMU\b/u,
    /\bPowerShell\b/u,
    /\bNVIDIA\b/u,
    /\bCUDA\b/u,
  ]) assert.equal(forbidden.test(source), false, `protected neutral authority leaked ${forbidden}`);

  assert.deepEqual(
    Object.getOwnPropertyNames(ExclusivePhysicalDeviceAuthorityClient.prototype),
    ['constructor', 'observe', 'claim', 'release', 'reconcile'],
  );
});
