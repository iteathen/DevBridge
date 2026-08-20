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
import { createRuntimeSet } from './runtime-set.js';
import { reportActiveRunRuntimeError } from './runtime-error-report.js';
import { runRuntimeSetCycle } from './run-once.js';

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
  runtimeSetFactory = createRuntimeSet,
} = {}) {
  const lockPath = path.join(config.state.directory, 'daemon.lock');
  const release = await acquireDaemonLock(lockPath);
  const lockRecord = release.record;
  try {
    const runtimeSet = await runtimeSetFactory(config, { env, fetchImpl, coordinationExclusive: true });
    onEvent({ type: 'daemon-started', at: new Date().toISOString(), pid: lockRecord.pid });
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
        const result = await runRuntimeSetCycle(runtimeSet, {
          onRuntimeError: (runtime, error) => reportActiveRunRuntimeError(runtime, error),
        });
        delay = result.recommendedPollIntervalMs ?? delay;
        onEvent({ type: 'cycle', at: new Date().toISOString(), result });
      } catch (error) {
        if (error instanceof RateLimitError && error.retryAt) delay = Math.max(delay, error.retryAt - Date.now());
        else delay = Math.max(delay, config.daemon.errorBackoffMs);

        let remoteReport = null;
        if (!(error instanceof RateLimitError)) {
          try {
            const reports = [];
            for (const runtime of runtimeSet.runtimes) {
              const report = await reportActiveRunRuntimeError(runtime, error);
              if (report.reported === true) reports.push({ queueRepository: runtime.queueRepository, ...report });
            }
            remoteReport = reports.length > 0
              ? { reported: true, reports }
              : { reported: false, reason: 'no-active-run' };
          } catch (reportError) {
            remoteReport = {
              reported: false,
              reason: 'runtime-error-report-failed',
              error: {
                name: reportError?.name ?? 'Error',
                message: reportError?.message ?? String(reportError),
              },
            };
          }
        }

        onEvent({
          type: 'cycle-error',
          at: new Date().toISOString(),
          error: { name: error.name, message: error.message },
          retryInMs: delay,
          remoteReport,
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
