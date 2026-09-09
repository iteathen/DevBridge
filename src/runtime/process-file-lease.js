import { spawn } from 'node:child_process';

const CONFLICT_EXIT_CODE = 75;
const MAX_OUTPUT_BYTES = 4 * 1024;
const DEFAULT_TIMINGS = Object.freeze({ sharedAcquireMs: 2_000, exclusiveAcquireMs: 32_000, releaseMs: 2_000, killMs: 1_000 });

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function timing(value, name) {
  if (!Number.isSafeInteger(value) || value < 10 || value > 300_000) throw new TypeError(`file lease ${name} is invalid`);
  return value;
}

function timings(value) {
  const selected = exactObject(value ?? DEFAULT_TIMINGS, new Set(Object.keys(DEFAULT_TIMINGS)), 'file lease timings');
  return Object.freeze(Object.fromEntries(Object.keys(DEFAULT_TIMINGS).map((name) => [name, timing(selected[name], name)])));
}

function signal(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || typeof value.aborted !== 'boolean'
    || typeof value.addEventListener !== 'function' || typeof value.removeEventListener !== 'function') {
    throw new TypeError('file lease cancellation signal is invalid');
  }
  return value;
}

function request(value) {
  const selected = exactObject(value, new Set(['mode', 'signal']), 'file lease request');
  if (!['shared', 'exclusive'].includes(selected.mode)) throw new TypeError('file lease mode is invalid');
  return Object.freeze({ mode: selected.mode, signal: signal(selected.signal) });
}

function childContract(value) {
  if (!value || typeof value !== 'object'
    || typeof value.once !== 'function' || typeof value.kill !== 'function'
    || !value.stdin || typeof value.stdin.end !== 'function'
    || !value.stdout || typeof value.stdout.on !== 'function'
    || !value.stderr || typeof value.stderr.on !== 'function') {
    throw new Error('file lease process contract is invalid');
  }
  return value;
}

function spawnOptions() {
  return Object.freeze({
    stdio: Object.freeze(['pipe', 'pipe', 'pipe']),
    shell: false,
    windowsHide: true,
    env: Object.freeze({ LANG: 'C', LC_ALL: 'C' }),
  });
}

function acquireProcess({ mode, command, readyLine, cancellation, start, policy }) {
  if (cancellation?.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let child;
    try { child = childContract(start(command.executable, command.arguments, spawnOptions())); }
    catch { reject(new Error('file lease process could not start')); return; }

    const expected = Buffer.from(readyLine, 'utf8');
    let output = Buffer.alloc(0);
    let outputBytes = 0;
    let ready = false;
    let acquiredSettled = false;
    let closed = false;
    let closeResult = null;
    let releaseRequested = false;
    let releaseComplete = false;
    let fault = null;
    const loss = new AbortController();
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
              else settle(null, fault ?? new Error('file lease process termination was not observable'));
            }
          }, policy.killMs);
        }
      }, policy.killMs);
    };
    const fail = (message) => {
      if (fault == null) fault = new Error(message);
      loss.abort(fault);
      terminate();
    };
    const append = (chunk, source) => {
      const next = Buffer.from(chunk);
      outputBytes += next.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { fail('file lease process output exceeded its bound'); return; }
      if (source === 'stderr' || ready) { fail('file lease process emitted unexpected output'); return; }
      output = Buffer.concat([output, next]);
      const newline = output.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== output.length - 1 || !output.equals(expected)) {
        fail('file lease process readiness evidence is invalid');
        return;
      }
      ready = true;
      settle(Object.freeze({
        signal: loss.signal,
        assertHeld() {
          if (closed || releaseRequested || fault != null) throw fault ?? new Error('file lease is no longer held');
        },
        async release() {
          if (releaseComplete) return;
          if (closed && !releaseRequested) throw new Error('file lease holder ended unexpectedly');
          releaseRequested = true;
          if (!closed) {
            try { child.stdin.end(); }
            catch { fail('file lease holder input could not close'); }
          }
          const releaseTimer = setTimeout(() => fail('file lease holder did not release in time'), policy.releaseMs);
          await closePromise;
          clearTimeout(releaseTimer);
          if (fault != null) throw fault;
          if (!closeResult || closeResult.code !== 0 || closeResult.signal != null) {
            throw new Error('file lease holder did not exit cleanly');
          }
          releaseComplete = true;
        },
      }));
    };
    const abort = () => { fail('file lease acquisition was cancelled'); };
    const acquireTimer = setTimeout(
      () => fail('file lease acquisition did not complete in time'),
      mode === 'shared' ? policy.sharedAcquireMs : policy.exclusiveAcquireMs,
    );

    child.stdin.on?.('error', () => {});
    child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
    child.once('error', () => fail('file lease process failed'));
    child.once('close', (code, exitSignal) => {
      closed = true;
      closeResult = Object.freeze({ code, signal: exitSignal ?? null });
      clearTimeout(hardTimer);
      clearTimeout(terminalTimer);
      finishClose(closeResult);
      if (!ready) {
        if (code === CONFLICT_EXIT_CODE || cancellation?.aborted) settle(null);
        else settle(null, fault ?? new Error(`file lease process ended before readiness (exit ${code}, signal ${exitSignal ?? 'none'})`));
      } else if (!releaseRequested && fault == null) {
        fault = new Error('file lease holder ended unexpectedly');
        loss.abort(fault);
      }
    });
    if (cancellation != null) cancellation.addEventListener('abort', abort, { once: true });
  });
}

export function createProcessFileLease({ commandFor, readyLine }, { spawnProcess = spawn, timingPolicy = DEFAULT_TIMINGS } = {}) {
  if (typeof commandFor !== 'function' || typeof readyLine !== 'string' || !readyLine.endsWith('\n') || readyLine.length > 1024 || typeof spawnProcess !== 'function') throw new TypeError('file lease process contract is invalid');
  const policy = timings(timingPolicy);
  return Object.freeze({
    async acquire(rawRequest) {
      const input = request(rawRequest);
      const command = commandFor(input.mode);
      return acquireProcess({ mode: input.mode, command, readyLine, cancellation: input.signal, start: spawnProcess, policy });
    },
  });
}
