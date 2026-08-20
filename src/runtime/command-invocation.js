import { spawn } from 'node:child_process';

const MAX_ARGUMENTS = 256;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function boundedText(value, name, { allowEmpty = false, maxBytes = 65_536 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} string`);
  }
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${name} is not bounded`);
  }
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function appendBounded(chunks, chunk, state, limit) {
  if (state.bytes >= limit) {
    state.truncated = true;
    return;
  }
  const buffer = Buffer.from(chunk);
  const remaining = limit - state.bytes;
  if (buffer.length > remaining) {
    chunks.push(buffer.subarray(0, remaining));
    state.bytes = limit;
    state.truncated = true;
    return;
  }
  chunks.push(buffer);
  state.bytes += buffer.length;
}

export async function invokeCommand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('command request must be an object');
  const executable = boundedText(raw.executable, 'command executable', { maxBytes: 4_096 });
  const argumentsList = raw.arguments ?? [];
  if (!Array.isArray(argumentsList) || argumentsList.length > MAX_ARGUMENTS) {
    throw new TypeError(`command arguments must contain at most ${MAX_ARGUMENTS} entries`);
  }
  const args = argumentsList.map((value, index) => boundedText(value, `command arguments[${index}]`, { allowEmpty: true, maxBytes: 65_536 }));
  const input = raw.input == null ? null : boundedText(raw.input, 'command input', { allowEmpty: true, maxBytes: 4 * 1024 * 1024 });
  const timeoutMs = integer(raw.timeoutMs ?? 15_000, 'command timeoutMs', 100, MAX_TIMEOUT_MS);
  const maxOutputBytes = integer(raw.maxOutputBytes ?? 1024 * 1024, 'command maxOutputBytes', 1024, MAX_OUTPUT_BYTES);
  const signal = raw.signal ?? null;
  if (signal != null && typeof signal !== 'object') throw new TypeError('command signal is invalid');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: raw.environment ?? process.env,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = [];
    const stderr = [];
    const state = { bytes: 0, truncated: false };
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abortListener);
      resolve(result);
    };

    const terminate = () => {
      if (!settled) child.kill('SIGTERM');
      const hardTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 1_000);
      hardTimer.unref?.();
    };

    const abortListener = () => {
      aborted = true;
      terminate();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();

    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    }

    child.stdout.on('data', (chunk) => appendBounded(stdout, chunk, state, maxOutputBytes));
    child.stderr.on('data', (chunk) => appendBounded(stderr, chunk, state, maxOutputBytes));
    child.on('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abortListener);
      reject(error);
    });
    child.on('close', (exitCode, exitSignal) => finish({
      exitCode,
      signal: exitSignal ?? null,
      timedOut,
      aborted,
      outputTruncated: state.truncated,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));

    if (input == null) child.stdin.end();
    else child.stdin.end(input);
  });
}
