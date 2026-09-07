import path from 'node:path';
import { RateLimitError } from '../errors.js';
import {
  acquireDaemonLock,
  acknowledgeDaemonPause,
  clearDaemonPauseAcknowledgement,
  consumeDaemonStopRequest,
  hasDaemonPauseRequest,
  waitForDaemonControlRequest,
  waitForDaemonResumeOrStop,
} from '../runtime/daemon-lock.js';
import { createRuntimeCollection } from './runtime-collection.js';
import { runRuntimeCollectionCycle } from './runtime-collection-cycle.js';
import { reportActiveRunRuntimeError } from './runtime-error-report.js';

function activityPort(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.acquire !== 'function' || typeof value.reconcile !== 'function') {
    throw new TypeError('daemon activity admission contract is incomplete');
  }
  return value;
}

function exactHeld(value, subject, operationId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('daemon activity admission evidence is invalid');
  for (const key of Object.keys(value)) if (!['subject', 'operationId', 'release'].includes(key)) throw new Error('daemon activity admission evidence is invalid');
  if (value.subject !== subject || value.operationId !== operationId || typeof value.release !== 'function') {
    throw new Error('daemon activity admission evidence is invalid');
  }
  return value;
}

async function admittedCycle(collection, admission, operationId, signal, cycle) {
  if (admission == null) return Object.freeze({ admitted: true, result: await cycle(collection) });
  const subject = 'cycle';
  const held = await admission.acquire(Object.freeze({ subject, operationId, signal }));
  if (held == null) return Object.freeze({ admitted: false, result: null });
  const selected = exactHeld(held, subject, operationId);
  let result;
  let failure = null;
  try { result = await cycle(collection); }
  catch (error) { failure = error; }
  try { await selected.release(); }
  catch (error) {
    if (failure != null) throw new AggregateError([failure, error], 'daemon cycle and activity release both failed');
    throw error;
  }
  if (failure != null) throw failure;
  return Object.freeze({ admitted: true, result });
}

async function honorPauseAtBoundary(lockPath, lockRecord, signal, onEvent) {
  if (!(await hasDaemonPauseRequest(lockPath, lockRecord))) return null;
  const acknowledged = await acknowledgeDaemonPause(lockPath, lockRecord);
  if (!acknowledged) return null;
  onEvent({ type: 'daemon-paused', at: new Date().toISOString() });
  try {
    const result = await waitForDaemonResumeOrStop(lockPath, lockRecord, signal);
    if (result === 'resumed') onEvent({ type: 'daemon-resumed', at: new Date().toISOString() });
    if (result === 'stop-requested') onEvent({ type: 'daemon-stop-requested', at: new Date().toISOString() });
    return result;
  } finally {
    await clearDaemonPauseAcknowledgement(lockPath, lockRecord);
  }
}

export async function runDaemon(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal = null,
  onEvent = () => {},
  collectionFactory = createRuntimeCollection,
  collectionCycle = runRuntimeCollectionCycle,
  activityAdmission = null,
} = {}) {
  const admission = activityPort(activityAdmission);
  const lockPath = path.join(config.state.directory, 'daemon.lock');
  const release = await acquireDaemonLock(lockPath);
  const lockRecord = release.record;
  try {
    if (admission != null) {
      const reconciled = await admission.reconcile(Object.freeze({ signal }));
      if (typeof reconciled !== 'boolean') throw new Error('daemon activity reconciliation evidence is invalid');
      if (reconciled) onEvent({ type: 'activity-reconciled', at: new Date().toISOString() });
    }
    const collection = await collectionFactory(config, { env, fetchImpl, coordinationExclusive: true });
    const cycleCollection = (value) => collectionCycle(value, {
      onRuntimeError: (runtime, error) => reportActiveRunRuntimeError(runtime, error),
    });
    onEvent({ type: 'daemon-started', at: new Date().toISOString(), pid: lockRecord.pid });
    let cycleSequence = 0;
    while (!signal?.aborted) {
      if (await consumeDaemonStopRequest(lockPath, lockRecord)) {
        onEvent({ type: 'daemon-stop-requested', at: new Date().toISOString() });
        break;
      }

      const pauseResult = await honorPauseAtBoundary(lockPath, lockRecord, signal, onEvent);
      if (pauseResult === 'stop-requested' || pauseResult === 'signal') break;
      if (signal?.aborted) break;

      let delay = config.github.pollIntervalMs;
      try {
        cycleSequence += 1;
        const cycle = await admittedCycle(collection, admission, `cycle-${lockRecord.token}-${cycleSequence}`, signal, cycleCollection);
        if (!cycle.admitted) {
          onEvent({ type: 'cycle-deferred', at: new Date().toISOString(), reason: 'activity-unavailable' });
        } else {
          const result = cycle.result;
          delay = result.recommendedPollIntervalMs ?? delay;
          onEvent({ type: 'cycle', at: new Date().toISOString(), result });
        }
      } catch (error) {
        if (error instanceof RateLimitError && error.retryAt) delay = Math.max(delay, error.retryAt - Date.now());
        else delay = Math.max(delay, config.daemon.errorBackoffMs);

        onEvent({
          type: 'cycle-error',
          at: new Date().toISOString(),
          error: { name: error.name, message: error.message },
          retryInMs: delay,
          remoteReport: null,
        });
      }

      if (!signal?.aborted) {
        const control = await waitForDaemonControlRequest(
          lockPath,
          lockRecord,
          Math.max(1000, delay),
          signal,
        );
        if (control === 'stop-requested') {
          onEvent({ type: 'daemon-stop-requested', at: new Date().toISOString() });
          break;
        }
      }
    }
    onEvent({ type: 'daemon-stopped', at: new Date().toISOString() });
  } finally {
    await release();
  }
}
