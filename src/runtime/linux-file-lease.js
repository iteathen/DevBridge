import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityLeaseHolderReadyLine } from './activity-lease-protocol.js';

const EXECUTABLE = '/usr/bin/flock';
const HOLDER = fileURLToPath(new URL('../entry/activity-lease-holder.mjs', import.meta.url));
const CONFLICT_EXIT_CODE = 75;
const MAX_OUTPUT_BYTES = 4 * 1024;
const DEFAULT_TIMINGS = Object.freeze({ sharedAcquireMs: 2_000, exclusiveAcquireMs: 32_000, releaseMs: 2_000, killMs: 1_000 });

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function subjectPath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)
    || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value || value === '/') {
    throw new TypeError('Linux file lease subject must be a normalized absolute path');
  }
  return value;
}

function timing(value, name) {
  if (!Number.isSafeInteger(value) || value < 10 || value > 300_000) throw new TypeError(`Linux file lease ${name} is invalid`);
  return value;
}

function timings(value) {
  const selected = exactObject(value ?? DEFAULT_TIMINGS, new Set(Object.keys(DEFAULT_TIMINGS)), 'Linux file lease timings');
  return Object.freeze(Object.fromEntries(Object.keys(DEFAULT_TIMINGS).map((name) => [name, timing(selected[name], name)])));
}

function signal(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || typeof value.aborted !== 'boolean'
    || typeof value.addEventListener !== 'function' || typeof value.removeEventListener !== 'function') {
    throw new TypeError('Linux file lease cancellation signal is invalid');
  }
  return value;
}

function request(value) {
  const selected = exactObject(value, new Set(['mode', 'signal']), 'Linux file lease request');
  if (!['shared', 'exclusive'].includes(selected.mode)) throw new TypeError('Linux file lease mode is invalid');
  return Object.freeze({ mode: selected.mode, signal: signal(selected.signal) });
}

function childContract(value) {
  if (!value || typeof value !== 'object'
    || typeof value.once !== 'function' || typeof value.kill !== 'function'
    || !value.stdin || typeof value.stdin.end !== 'function'
    || !value.stdout || typeof value.stdout.on !== 'function'
    || !value.stderr || typeof value.stderr.on !== 'function') {
    throw new Error('Linux file lease process contract is invalid');
  }
  return value;
}

function argumentsFor(mode, target) {
  return Object.freeze([
    '--no-fork',
    mode === 'shared' ? '--shared' : '--exclusive',
    ...(mode === 'shared' ? ['--nonblock'] : ['--timeout', '30']),
    '--conflict-exit-code', String(CONFLICT_EXIT_CODE),
    '--', target, process.execPath, HOLDER,
  ]);
}

function spawnOptions() {
  return Object.freeze({
    stdio: Object.freeze(['pipe', 'pipe', 'pipe']),
    shell: false,
    windowsHide: true,
    env: Object.freeze({ LANG: 'C', LC_ALL: 'C' }),
  });
}

function acquireProcess({ mode, target, cancellation, start, policy }) {
  if (cancellation?.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let child;
    try { child = childContract(start(EXECUTABLE, argumentsFor(mode, target), spawnOptions())); }
    catch { reject(new Error('Linux file lease process could not start')); return; }

    const expected = Buffer.from(activityLeaseHolderReadyLine(), 'utf8');
    let output = Buffer.alloc(0);
    let outputBytes = 0;
    let ready = false;
    let acquiredSettled = false;
    let closed = false;
    let closeResult = null;
    let releaseRequested = false;
    let releaseComplete = false;
    let fault = null;
    let terminating = false;
    let hardTimer = null;
    let terminalTimer = null;
    let closeSettled = false;
    let closeResolve;
    const closePromise = new Promise((done) => { closeResolve = done; });

    const finishClose = (value) => {
      if (closeSettled) return;
      closeSettled = true;
      closeResolve(value);
    };

    const removeCancellation = () => cancellation?.removeEventListener('abort', abort);
    const settle = (value, error = null) => {
      if (acquiredSettled) return;
      acquiredSettled = true;
      clearTimeout(acquireTimer);
      removeCancellation();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = () => {
      if (closed || terminating) return;
      terminating = true;
      try { child.stdin.end(); } catch { /* Continue to signal termination. */ }
      try { child.kill('SIGTERM'); } catch { /* Escalation remains bounded. */ }
      hardTimer = setTimeout(() => {
        if (!closed) {
          try { child.kill('SIGKILL'); } catch { /* Close observation remains authoritative. */ }
          terminalTimer = setTimeout(() => {
            if (closed) return;
            finishClose(null);
            if (!ready) {
              if (cancellation?.aborted) settle(null);
              else settle(null, fault ?? new Error('Linux file lease process termination was not observable'));
            }
          }, policy.killMs);
          terminalTimer.unref?.();
        }
      }, policy.killMs);
      hardTimer.unref?.();
    };
    const fail = (message) => {
      if (fault == null) fault = new Error(message);
      terminate();
    };
    const append = (chunk, source) => {
      const next = Buffer.from(chunk);
      outputBytes += next.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { fail('Linux file lease process output exceeded its bound'); return; }
      if (source === 'stderr' || ready) { fail('Linux file lease process emitted unexpected output'); return; }
      output = Buffer.concat([output, next]);
      const newline = output.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== output.length - 1 || !output.equals(expected)) {
        fail('Linux file lease process readiness evidence is invalid');
        return;
      }
      ready = true;
      settle(Object.freeze({
        async release() {
          if (releaseComplete) return;
          if (closed && !releaseRequested) throw new Error('Linux file lease holder ended unexpectedly');
          releaseRequested = true;
          if (!closed) {
            try { child.stdin.end(); }
            catch { fail('Linux file lease holder input could not close'); }
          }
          const releaseTimer = setTimeout(() => fail('Linux file lease holder did not release in time'), policy.releaseMs);
          releaseTimer.unref?.();
          await closePromise;
          clearTimeout(releaseTimer);
          if (fault != null) throw fault;
          if (!closeResult || closeResult.code !== 0 || closeResult.signal != null) {
            throw new Error('Linux file lease holder did not exit cleanly');
          }
          releaseComplete = true;
        },
      }));
    };
    const abort = () => { fail('Linux file lease acquisition was cancelled'); };
    const acquireTimer = setTimeout(
      () => fail('Linux file lease acquisition did not complete in time'),
      mode === 'shared' ? policy.sharedAcquireMs : policy.exclusiveAcquireMs,
    );
    acquireTimer.unref?.();

    child.stdin.on?.('error', () => {});
    child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
    child.once('error', () => fail('Linux file lease process failed'));
    child.once('close', (code, exitSignal) => {
      closed = true;
      closeResult = Object.freeze({ code, signal: exitSignal ?? null });
      clearTimeout(hardTimer);
      clearTimeout(terminalTimer);
      finishClose(closeResult);
      if (!ready) {
        if (code === CONFLICT_EXIT_CODE || cancellation?.aborted) settle(null);
        else settle(null, fault ?? new Error('Linux file lease process ended before readiness'));
      } else if (!releaseRequested && fault == null) {
        fault = new Error('Linux file lease holder ended unexpectedly');
      }
    });
    if (cancellation != null) cancellation.addEventListener('abort', abort, { once: true });
  });
}

export function createLinuxFileLease(raw = {}, {
  spawnProcess = spawn,
  timingPolicy = DEFAULT_TIMINGS,
} = {}) {
  const selected = exactObject(raw, new Set(['subjectPath']), 'Linux file lease configuration');
  const target = subjectPath(selected.subjectPath);
  if (typeof spawnProcess !== 'function') throw new TypeError('Linux file lease process port is invalid');
  const policy = timings(timingPolicy);
  return Object.freeze({
    async acquire(rawRequest) {
      const input = request(rawRequest);
      return acquireProcess({ mode: input.mode, target, cancellation: input.signal, start: spawnProcess, policy });
    },
  });
}
