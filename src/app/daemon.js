import path from 'node:path';
import { RateLimitError } from '../errors.js';
import { acquireDaemonLock } from '../runtime/daemon-lock.js';
import { createRuntime } from './runtime.js';
import { runCycle } from './run-once.js';

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export async function runDaemon(config, { env = process.env, fetchImpl = globalThis.fetch, signal = null, onEvent = () => {} } = {}) {
  const release = await acquireDaemonLock(path.join(config.state.directory, 'daemon.lock'));
  try {
    const runtime = await createRuntime(config, { env, fetchImpl });
    onEvent({ type: 'daemon-started', at: new Date().toISOString() });
    while (!signal?.aborted) {
      let delay = config.github.pollIntervalMs;
      try {
        const result = await runCycle(runtime);
        delay = result.recommendedPollIntervalMs ?? delay;
        onEvent({ type: 'cycle', at: new Date().toISOString(), result });
      } catch (error) {
        if (error instanceof RateLimitError && error.retryAt) delay = Math.max(delay, error.retryAt - Date.now());
        else delay = Math.max(delay, config.daemon.errorBackoffMs);
        onEvent({ type: 'cycle-error', at: new Date().toISOString(), error: { name: error.name, message: error.message }, retryInMs: delay });
      }
      if (!signal?.aborted) await sleep(Math.max(1000, delay), signal);
    }
    onEvent({ type: 'daemon-stopped', at: new Date().toISOString() });
  } finally { await release(); }
}
