import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonPauseAdmission } from '../src/app/daemon-pause-admission.js';

test('pause admission resumes only the pause it owns', async () => {
  const events = [];
  const admission = createDaemonPauseAdmission({
    stateDirectory: '/state',
    pause: async (file) => { events.push(['pause', file]); return { activeLock: true, requested: true, alreadyRequested: false, paused: true }; },
    resume: async (file) => { events.push(['resume', file]); return { activeLock: true, resumed: true }; },
  });
  const held = await admission.acquire({ subject: 'environment-1', operationId: 'operation-1' });
  assert.equal(held.subject, 'environment-1');
  await held.release();
  await held.release();
  assert.equal(events.filter(([kind]) => kind === 'resume').length, 1);
});

test('pause admission preserves an existing pause and fails before an unsafe boundary', async () => {
  let resumed = false;
  const existing = createDaemonPauseAdmission({
    stateDirectory: '/state',
    pause: async () => ({ activeLock: true, requested: true, alreadyRequested: true, paused: true }),
    resume: async () => { resumed = true; return { resumed: true }; },
  });
  await (await existing.acquire({ subject: 'environment-1', operationId: 'operation-1' })).release();
  assert.equal(resumed, false);

  const unsafe = createDaemonPauseAdmission({
    stateDirectory: '/state',
    pause: async () => ({ activeLock: true, requested: true, alreadyRequested: false, paused: false }),
    resume: async () => ({ resumed: true }),
  });
  await assert.rejects(() => unsafe.acquire({ subject: 'environment-1', operationId: 'operation-1' }), /safe boundary/u);
});
