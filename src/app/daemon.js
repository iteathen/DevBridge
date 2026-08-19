import path from 'node:path';
import { RateLimitError } from '../errors.js';
import {
  acquireDaemonLock,
  consumeDaemonStopRequest,
  waitForDaemonStopRequest,
} from '../runtime/daemon-lock.js';
import { createRuntime } from './runtime.js';
import { reportActiveRunRuntimeError } from './runtime-error-report.js';
import { runCycle } from './run-once.js';

export async function runDaemon(config, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal = null,
  onEvent = () => {},
  runtimeFactory = createRuntime,
} = {}) {
  const lockPath = path.join(config.state.directory, 'daemon.lock');
  const release = await acquireDaemonLock(lockPath);
  const lockRecord = release.record;
  try {
    const runtime = await runtimeFactory(config, { env, fetchImpl, coordinationExclusive: true });
    onEvent({ type: 'daemon-started', at: new Date().toISOString(), pid: lockRecord.pid });
    while (!signal?.aborted) {
      if (await consumeDaemonStopRequest(lockPath, lockRecord)) {
        onEvent({ type: 'daemon-stop-requested', at: new Date().toISOString() });
        break;
      }

      let delay = config.github.pollIntervalMs;
      try {
        const result = await runCycle(runtime);
        delay = result.recommendedPollIntervalMs ?? delay;
        onEvent({ type: 'cycle', at: new Date().toISOString(), result });
      } catch (error) {
        if (error instanceof RateLimitError && error.retryAt) delay = Math.max(delay, error.retryAt - Date.now());
        else delay = Math.max(delay, config.daemon.errorBackoffMs);

        let remoteReport = null;
        if (!(error instanceof RateLimitError)) {
          try {
            remoteReport = await reportActiveRunRuntimeError(runtime, error);
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
        const stopRequested = await waitForDaemonStopRequest(
          lockPath,
          lockRecord,
          Math.max(1000, delay),
          signal,
        );
        if (stopRequested) {
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
