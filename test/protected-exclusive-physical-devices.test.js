import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProtectedExclusivePhysicalDevices } from '../src/runtime/protected-exclusive-physical-devices.js';

const SUBJECT = 'device-primary-accelerator';
const DEVICE_GENERATION = 'device-gen-1';
const ENVIRONMENT = Object.freeze({ identity: 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', generation: '7' });
const FOREIGN_ENVIRONMENT = Object.freeze({ identity: 'env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', generation: '2' });

function fixture() {
  let eligible = true;
  let critical = false;
  let admitted = true;
  let preparationReady = true;
  let preparationGeneration = 'prep-1';
  let observeHook = null;
  let claimCalls = 0;
  let releaseCalls = 0;
  let observeCalls = 0;
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
        eligible,
        critical,
        capabilities: ['exclusive-accelerator'],
        reason: critical ? 'device is required by local host policy' : null,
      };
    },
  };
  const environments = {
    async observe(environment) {
      return { ...environment, admitted, reason: admitted ? null : 'environment is no longer admitted' };
    },
  };
  const preparation = {
    async observe(environment) {
      return {
        ...environment,
        ready: preparationReady,
        preparationGeneration,
        reason: preparationReady ? null : 'preparation is no longer ready',
      };
    },
  };
  const assignment = {
    async observe(subject) {
      assert.equal(subject, SUBJECT);
      const result = structuredClone(observation);
      observeCalls += 1;
      if (observeHook) {
        const hook = observeHook;
        observeHook = null;
        await hook(observeCalls);
      }
      return result;
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
      return { ...environment, qualified: true, qualificationGeneration: 'qualification-1', reason: null };
    },
  };

  return {
    inventory,
    environments,
    preparation,
    assignment,
    guestLifecycle,
    qualification,
    setCritical(value) { critical = value; },
    setEligible(value) { eligible = value; },
    setAdmitted(value) { admitted = value; },
    setPreparationGeneration(value) { preparationGeneration = value; },
    setPreparationReady(value) { preparationReady = value; },
    afterNextProviderObservation(callback) { observeHook = callback; },
    forceObservation(value) { observation = structuredClone(value); },
    claimCalls() { return claimCalls; },
    releaseCalls() { return releaseCalls; },
    observeCalls() { return observeCalls; },
    observation() { return structuredClone(observation); },
  };
}

function authority(directory, fake) {
  return createProtectedExclusivePhysicalDevices({
    directory,
    inventory: fake.inventory,
    environments: fake.environments,
    assignment: fake.assignment,
    preparation: fake.preparation,
    guestLifecycle: fake.guestLifecycle,
    qualification: fake.qualification,
  });
}

async function withFixture(prefix, work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const fake = fixture();
  try { await work(directory, fake); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function driftAfterCompleteClaimObservation(fake, drift) {
  let armed = false;
  const originalObserve = fake.assignment.observe.bind(fake.assignment);
  fake.assignment.observe = async (subject) => {
    const result = await originalObserve(subject);
    if (!armed && fake.observeCalls() === 2) {
      armed = true;
      await drift();
    }
    return result;
  };
}

test('protected composition revalidates host policy immediately before provider claim effect', async () => {
  await withFixture('db-protected-policy-drift-', async (directory, fake) => {
    await driftAfterCompleteClaimObservation(fake, async () => fake.setCritical(true));
    const devices = authority(directory, fake);
    await assert.rejects(devices.claim(SUBJECT, ENVIRONMENT), /local host policy|host-critical/u);
    assert.equal(fake.claimCalls(), 0);
    assert.equal(fake.observation().state, 'available');
  });
});

test('protected composition revalidates environment admission immediately before provider claim effect', async () => {
  await withFixture('db-protected-admission-drift-', async (directory, fake) => {
    await driftAfterCompleteClaimObservation(fake, async () => fake.setAdmitted(false));
    const devices = authority(directory, fake);
    await assert.rejects(devices.claim(SUBJECT, ENVIRONMENT), /no longer admitted/u);
    assert.equal(fake.claimCalls(), 0);
  });
});

test('protected composition fences preparation-generation drift immediately before provider claim effect', async () => {
  await withFixture('db-protected-preparation-drift-', async (directory, fake) => {
    await driftAfterCompleteClaimObservation(fake, async () => fake.setPreparationGeneration('prep-2'));
    const devices = authority(directory, fake);
    await assert.rejects(devices.claim(SUBJECT, ENVIRONMENT), /preparation generation changed/u);
    assert.equal(fake.claimCalls(), 0);
  });
});

test('protected composition reobserves root-safe provider ownership immediately before claim effect', async () => {
  await withFixture('db-protected-owner-drift-', async (directory, fake) => {
    await driftAfterCompleteClaimObservation(fake, async () => fake.forceObservation({
      subject: SUBJECT,
      deviceGeneration: DEVICE_GENERATION,
      state: 'owned',
      rootSafe: false,
      owner: FOREIGN_ENVIRONMENT,
      assignmentGeneration: 'assignment-foreign',
      reason: 'provider owner changed',
    }));
    const devices = authority(directory, fake);
    await assert.rejects(devices.claim(SUBJECT, ENVIRONMENT), /provider owner changed|root-safe/u);
    assert.equal(fake.claimCalls(), 0);
  });
});

test('protected release remains available after policy becomes restrictive', async () => {
  await withFixture('db-protected-release-policy-', async (directory, fake) => {
    const devices = authority(directory, fake);
    const claimed = await devices.claim(SUBJECT, ENVIRONMENT);
    fake.setCritical(true);
    fake.setEligible(false);
    fake.setAdmitted(false);
    fake.setPreparationReady(false);

    const released = await devices.release(claimed.claim);
    assert.equal(released.state, 'AVAILABLE');
    assert.equal(released.provider.rootSafe, true);
    assert.equal(fake.releaseCalls(), 1);
  });
});

test('protected release reobserves exact owner immediately before provider release effect', async () => {
  await withFixture('db-protected-release-owner-drift-', async (directory, fake) => {
    const devices = authority(directory, fake);
    const claimed = await devices.claim(SUBJECT, ENVIRONMENT);
    fake.afterNextProviderObservation(async () => fake.forceObservation({
      subject: SUBJECT,
      deviceGeneration: DEVICE_GENERATION,
      state: 'owned',
      rootSafe: false,
      owner: FOREIGN_ENVIRONMENT,
      assignmentGeneration: 'assignment-foreign',
      reason: 'provider owner changed before release',
    }));

    await assert.rejects(devices.release(claimed.claim), /exact provider owner/u);
    assert.equal(fake.releaseCalls(), 0);
    assert.deepEqual(fake.observation().owner, FOREIGN_ENVIRONMENT);
  });
});
