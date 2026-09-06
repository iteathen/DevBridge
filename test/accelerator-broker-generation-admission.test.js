import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcceleratorBrokerGenerationAdmission } from '../src/runtime/accelerator-broker-generation-admission.js';

function turn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('generation admission allows concurrent shared holders', async () => {
  const admission = createAcceleratorBrokerGenerationAdmission();
  const first = await admission.acquire({ mode: 'shared' });
  const second = await admission.acquire({ mode: 'shared' });
  assert.equal(first.mode, 'shared');
  assert.equal(second.mode, 'shared');
  await first.release();
  await second.release();
});

test('exclusive admission drains active shared holders and later shared work cannot overtake it', async () => {
  const admission = createAcceleratorBrokerGenerationAdmission();
  const active = await admission.acquire({ mode: 'shared' });
  let exclusiveResolved = false;
  let laterSharedResolved = false;
  const exclusivePromise = admission.acquire({ mode: 'exclusive' }).then((value) => {
    exclusiveResolved = true;
    return value;
  });
  const laterSharedPromise = admission.acquire({ mode: 'shared' }).then((value) => {
    laterSharedResolved = true;
    return value;
  });
  await turn();
  assert.equal(exclusiveResolved, false);
  assert.equal(laterSharedResolved, false);

  await active.release();
  const exclusive = await exclusivePromise;
  assert.equal(exclusive.mode, 'exclusive');
  assert.equal(laterSharedResolved, false);

  await exclusive.release();
  const laterShared = await laterSharedPromise;
  assert.equal(laterShared.mode, 'shared');
  await laterShared.release();
});

test('exclusive admission waits for every active reader', async () => {
  const admission = createAcceleratorBrokerGenerationAdmission();
  const first = await admission.acquire({ mode: 'shared' });
  const second = await admission.acquire({ mode: 'shared' });
  let resolved = false;
  const pending = admission.acquire({ mode: 'exclusive' }).then((value) => {
    resolved = true;
    return value;
  });
  await first.release();
  await turn();
  assert.equal(resolved, false);
  await second.release();
  const exclusive = await pending;
  assert.equal(resolved, true);
  await exclusive.release();
});

test('cancelled queued admission does not block later work', async () => {
  const admission = createAcceleratorBrokerGenerationAdmission();
  const active = await admission.acquire({ mode: 'shared' });
  const controller = new AbortController();
  const cancelled = admission.acquire({ mode: 'exclusive', signal: controller.signal });
  const later = admission.acquire({ mode: 'shared' });
  controller.abort();
  assert.equal(await cancelled, null);
  await active.release();
  const shared = await later;
  assert.equal(shared.mode, 'shared');
  await shared.release();
});
