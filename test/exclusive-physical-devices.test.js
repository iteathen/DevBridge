import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExclusivePhysicalDevices } from '../src/runtime/exclusive-physical-devices.js';

const SUBJECT = 'device-primary-accelerator';
const DEVICE_GENERATION = 'device-gen-1';
const ENV_A = { identity: 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', generation: '7' };
const ENV_B = { identity: 'env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', generation: '4' };

function fixture() {
  let deviceGeneration = DEVICE_GENERATION;
  let observation = {
    subject: SUBJECT,
    deviceGeneration,
    state: 'available',
    rootSafe: true,
    owner: null,
    assignmentGeneration: null,
    reason: null,
  };
  let eligible = true;
  let critical = false;
  let admission = true;
  let preparationReady = true;
  let preparationGeneration = 'prep-1';
  let qualificationReady = true;
  let quiesceReady = true;
  let rebindReady = true;
  let leakProviderIdentity = false;
  let failBeforeClaimEffect = false;
  let failAfterClaimEffect = false;
  let failAfterReleaseEffect = false;
  let claimCalls = 0;
  let releaseCalls = 0;
  let quiesceCalls = 0;
  let rebindCalls = 0;
  let qualificationCalls = 0;

  const inventory = {
    async resolve(subject) {
      return {
        subject,
        generation: deviceGeneration,
        eligible,
        critical,
        capabilities: ['exclusive-accelerator', 'native-device'],
        reason: critical ? 'device is required by the host console' : null,
      };
    },
  };
  const environments = {
    async observe(environment) {
      return { ...environment, admitted: admission, reason: admission ? null : 'environment is not admitted' };
    },
  };
  const preparation = {
    async observe(environment) {
      return {
        ...environment,
        ready: preparationReady,
        preparationGeneration,
        reason: preparationReady ? null : 'profile preparation is stale',
      };
    },
  };
  const assignment = {
    async observe(subject) {
      const value = structuredClone({ ...observation, subject, deviceGeneration });
      if (leakProviderIdentity) value.pciAddress = '0000:01:00.0';
      return value;
    },
    async claim({ subject, deviceGeneration: expectedGeneration, environment }) {
      assert.equal(subject, SUBJECT);
      assert.equal(expectedGeneration, deviceGeneration);
      claimCalls += 1;
      if (failBeforeClaimEffect) {
        failBeforeClaimEffect = false;
        throw new Error('simulated interruption before claim effect');
      }
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
        throw new Error('simulated interruption after claim effect');
      }
    },
    async release({ subject, deviceGeneration: expectedGeneration, environment, assignmentGeneration }) {
      assert.equal(subject, SUBJECT);
      assert.equal(expectedGeneration, deviceGeneration);
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
        throw new Error('simulated interruption after release effect');
      }
    },
  };
  const guestLifecycle = {
    async quiesce({ environment }) {
      quiesceCalls += 1;
      return { ...environment, quiesced: quiesceReady, environmentStopped: true, reason: quiesceReady ? null : 'active device work remains' };
    },
    async rebind({ environment }) {
      rebindCalls += 1;
      return { ...environment, ready: rebindReady, environmentRestarted: true, reason: rebindReady ? null : 'device did not re-enumerate' };
    },
  };
  const qualification = {
    async qualify({ environment }) {
      qualificationCalls += 1;
      return { ...environment, qualified: qualificationReady, qualificationGeneration: `qualification-${qualificationCalls}`, reason: qualificationReady ? null : 'native device canary failed' };
    },
  };

  return {
    inventory, environments, preparation, assignment, guestLifecycle, qualification,
    setEligible(value) { eligible = value; },
    setCritical(value) { critical = value; },
    setAdmission(value) { admission = value; },
    setPreparationReady(value) { preparationReady = value; },
    setPreparationGeneration(value) { preparationGeneration = value; },
    setQualificationReady(value) { qualificationReady = value; },
    setQuiesceReady(value) { quiesceReady = value; },
    setRebindReady(value) { rebindReady = value; },
    setLeakProviderIdentity(value) { leakProviderIdentity = value; },
    failNextClaimBeforeEffect() { failBeforeClaimEffect = true; },
    failNextClaimAfterEffect() { failAfterClaimEffect = true; },
    failNextReleaseAfterEffect() { failAfterReleaseEffect = true; },
    setDeviceGeneration(value) { deviceGeneration = value; },
    forceObservation(value) { observation = structuredClone(value); },
    observation() { return structuredClone(observation); },
    claimCalls() { return claimCalls; },
    releaseCalls() { return releaseCalls; },
    quiesceCalls() { return quiesceCalls; },
    rebindCalls() { return rebindCalls; },
    qualificationCalls() { return qualificationCalls; },
  };
}

function authority(root, fake, overrides = {}) {
  return new ExclusivePhysicalDevices({
    directory: root,
    inventory: fake.inventory,
    environments: fake.environments,
    assignment: fake.assignment,
    preparation: fake.preparation,
    guestLifecycle: fake.guestLifecycle,
    qualification: fake.qualification,
    ...overrides,
  });
}

async function withFixture(prefix, work) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const fake = fixture();
  try { await work(root, fake); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('claim and release switch exclusive ownership while preserving durable guest preparation', async () => {
  await withFixture('db-device-switch-', async (root, fake) => {
    const devices = authority(root, fake);
    const claimed = await devices.claim(SUBJECT, ENV_A);
    assert.equal(claimed.state, 'OWNED');
    assert.deepEqual(claimed.claim.environment, ENV_A);
    assert.equal(claimed.provider.rootSafe, false);
    assert.equal(fake.claimCalls(), 1);
    assert.equal(fake.rebindCalls(), 1);
    assert.equal(fake.qualificationCalls(), 1);

    await assert.rejects(() => devices.claim(SUBJECT, ENV_B), /not available/u);

    const released = await devices.release(claimed.claim);
    assert.equal(released.state, 'AVAILABLE');
    assert.equal(released.claim, null);
    assert.equal(released.provider.rootSafe, true);
    assert.equal(released.formerOwnerPreparationReady, true);
    assert.equal(released.formerOwnerPreparationGeneration, 'prep-1');
    assert.equal(fake.releaseCalls(), 1);
    assert.equal(fake.quiesceCalls(), 1);

    const switched = await devices.claim(SUBJECT, ENV_B);
    assert.equal(switched.state, 'OWNED');
    assert.deepEqual(switched.claim.environment, ENV_B);
    assert.equal(fake.claimCalls(), 2);
  });
});

test('host-critical, unapproved, unadmitted, and unprepared subjects fail before provider mutation', async () => {
  await withFixture('db-device-admission-', async (root, fake) => {
    let devices = authority(root, fake);
    fake.setCritical(true);
    await assert.rejects(() => devices.claim(SUBJECT, ENV_A), /required by the host console/u);
    fake.setCritical(false);
    fake.setEligible(false);
    await assert.rejects(() => devices.claim(SUBJECT, ENV_A), /not locally approved/u);
    fake.setEligible(true);
    fake.setAdmission(false);
    await assert.rejects(() => devices.claim(SUBJECT, ENV_A), /not admitted/u);
    fake.setAdmission(true);
    fake.setPreparationReady(false);
    await assert.rejects(() => devices.claim(SUBJECT, ENV_A), /preparation is stale/u);
    assert.equal(fake.claimCalls(), 0);
  });
});

test('ambiguous claim interruption is reconciled by observation without a duplicate provider claim', async () => {
  await withFixture('db-device-claim-reconcile-', async (root, fake) => {
    fake.failNextClaimAfterEffect();
    let devices = authority(root, fake);
    await assert.rejects(() => devices.claim(SUBJECT, ENV_A), /simulated interruption/u);
    assert.equal(fake.claimCalls(), 1);
    assert.equal(fake.observation().state, 'owned');

    devices = authority(root, fake);
    const reconciled = await devices.reconcile(SUBJECT);
    assert.equal(reconciled.state, 'OWNED');
    assert.deepEqual(reconciled.claim.environment, ENV_A);
    assert.equal(fake.claimCalls(), 1);
    assert.equal(fake.qualificationCalls(), 1);
  });
});

test('ambiguous release interruption is reconciled from root-safe observation without a duplicate release', async () => {
  await withFixture('db-device-release-reconcile-', async (root, fake) => {
    let devices = authority(root, fake);
    const claimed = await devices.claim(SUBJECT, ENV_A);
    fake.failNextReleaseAfterEffect();
    await assert.rejects(() => devices.release(claimed.claim), /simulated interruption/u);
    assert.equal(fake.releaseCalls(), 1);
    assert.equal(fake.observation().state, 'available');

    devices = authority(root, fake);
    const reconciled = await devices.reconcile(SUBJECT);
    assert.equal(reconciled.state, 'AVAILABLE');
    assert.equal(reconciled.claim, null);
    assert.equal(fake.releaseCalls(), 1);
  });
});

test('failed qualification leaves the assigned device recovery-required and blocks another owner until reconciliation', async () => {
  await withFixture('db-device-qualification-', async (root, fake) => {
    let devices = authority(root, fake);
    fake.setQualificationReady(false);
    await assert.rejects(() => devices.claim(SUBJECT, ENV_A), /canary failed/u);
    const status = await devices.observe(SUBJECT);
    assert.equal(status.state, 'RECOVERY_REQUIRED');
    assert.equal(status.provider.state, 'owned');
    await assert.rejects(() => devices.claim(SUBJECT, ENV_B), /unreconciled/u);

    fake.setQualificationReady(true);
    devices = authority(root, fake);
    const recovered = await devices.reconcile(SUBJECT);
    assert.equal(recovered.state, 'OWNED');
    assert.deepEqual(recovered.claim.environment, ENV_A);
    assert.equal(fake.claimCalls(), 1);
  });
});

test('unexpected owner drift is quarantined instead of adopted or released by guess', async () => {
  await withFixture('db-device-owner-drift-', async (root, fake) => {
    const devices = authority(root, fake);
    const claimed = await devices.claim(SUBJECT, ENV_A);
    fake.forceObservation({
      subject: SUBJECT,
      deviceGeneration: DEVICE_GENERATION,
      state: 'owned',
      rootSafe: false,
      owner: ENV_B,
      assignmentGeneration: 'foreign-assignment',
      reason: null,
    });
    const reconciled = await devices.reconcile(SUBJECT);
    assert.equal(reconciled.state, 'QUARANTINED');
    await assert.rejects(() => devices.release(claimed.claim), /no longer authoritative|unreconciled/u);
    assert.equal(fake.releaseCalls(), 0);
  });
});

test('device generation drift invalidates old claim authority', async () => {
  await withFixture('db-device-generation-', async (root, fake) => {
    let devices = authority(root, fake);
    const claimed = await devices.claim(SUBJECT, ENV_A);
    fake.setDeviceGeneration('device-gen-2');
    fake.forceObservation({
      subject: SUBJECT,
      deviceGeneration: 'device-gen-2',
      state: 'available',
      rootSafe: true,
      owner: null,
      assignmentGeneration: null,
      reason: null,
    });
    devices = authority(root, fake);
    const recovered = await devices.reconcile(SUBJECT);
    assert.equal(recovered.state, 'RECOVERY_REQUIRED');
    await assert.rejects(() => devices.release(claimed.claim), /generation changed|stale/u);
  });
});

test('provider-native identities are rejected at the neutral observation boundary', async () => {
  await withFixture('db-device-provider-leak-', async (root, fake) => {
    fake.setLeakProviderIdentity(true);
    const devices = authority(root, fake);
    await assert.rejects(() => devices.observe(SUBJECT), /pciAddress is not allowed/u);
    await assert.rejects(() => devices.claim(SUBJECT, ENV_A), /pciAddress is not allowed/u);
    assert.equal(fake.claimCalls(), 0);
  });
});

test('release requires quiescence before provider removal and never releases on failed drain', async () => {
  await withFixture('db-device-quiesce-', async (root, fake) => {
    const devices = authority(root, fake);
    const claimed = await devices.claim(SUBJECT, ENV_A);
    fake.setQuiesceReady(false);
    await assert.rejects(() => devices.release(claimed.claim), /active device work remains/u);
    assert.equal(fake.releaseCalls(), 0);
    assert.equal(fake.observation().state, 'owned');
    const status = await devices.observe(SUBJECT);
    assert.equal(status.state, 'RELEASE_FAILED');
  });
});

test('claim reconciliation revalidates exact guest preparation before retrying a provider effect', async () => {
  await withFixture('db-device-prep-reconcile-', async (root, fake) => {
    fake.failNextClaimBeforeEffect();
    let devices = authority(root, fake);
    await assert.rejects(() => devices.claim(SUBJECT, ENV_A), /simulated interruption before claim effect/u);
    assert.equal(fake.claimCalls(), 1);
    assert.equal(fake.observation().state, 'available');

    fake.setPreparationGeneration('prep-2');
    devices = authority(root, fake);
    const reconciled = await devices.reconcile(SUBJECT);
    assert.equal(reconciled.state, 'RECOVERY_REQUIRED');
    assert.match(reconciled.reason, /preparation generation changed/u);
    assert.equal(fake.claimCalls(), 1);
    assert.equal(fake.observation().state, 'available');
  });
});

test('explicit reconciliation clears quarantine only after root-safe provider observation', async () => {
  await withFixture('db-device-root-safe-recovery-', async (root, fake) => {
    const devices = authority(root, fake);
    await devices.claim(SUBJECT, ENV_A);
    fake.forceObservation({
      subject: SUBJECT,
      deviceGeneration: DEVICE_GENERATION,
      state: 'owned',
      rootSafe: false,
      owner: ENV_B,
      assignmentGeneration: 'foreign-assignment',
      reason: null,
    });
    const quarantined = await devices.reconcile(SUBJECT);
    assert.equal(quarantined.state, 'QUARANTINED');

    fake.forceObservation({
      subject: SUBJECT,
      deviceGeneration: DEVICE_GENERATION,
      state: 'available',
      rootSafe: true,
      owner: null,
      assignmentGeneration: null,
      reason: null,
    });
    const recovered = await devices.reconcile(SUBJECT);
    assert.equal(recovered.state, 'AVAILABLE');
    assert.equal(recovered.claim, null);

    const claimed = await devices.claim(SUBJECT, ENV_B);
    assert.equal(claimed.state, 'OWNED');
    assert.deepEqual(claimed.claim.environment, ENV_B);
  });
});

test('separate authority instances cannot overlap one durable device lifecycle mutation', async () => {
  await withFixture('db-device-lock-', async (root, fake) => {
    let entered;
    let proceed;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { proceed = resolve; });
    const environments = {
      async observe(environment) {
        entered();
        await blocked;
        return { ...environment, admitted: true, reason: null };
      },
    };
    const first = authority(root, fake, { environments });
    const second = authority(root, fake);
    const pending = first.claim(SUBJECT, ENV_A);
    await waiting;
    await assert.rejects(() => second.claim(SUBJECT, ENV_B), /lifecycle mutation is already active/u);
    assert.equal(fake.claimCalls(), 0);
    proceed();
    const claimed = await pending;
    assert.equal(claimed.state, 'OWNED');
    assert.equal(fake.claimCalls(), 1);
  });
});
