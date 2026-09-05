import { spawn } from 'node:child_process';
import path from 'node:path';

const PROGRAM = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const CONTROL_INTERVAL_MS = 250;
const MAX_TIMEOUT_MS = 28_800_000;
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function boundedString(value, name, { allowEmpty = false, maxBytes = 8_192 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new TypeError(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} string`);
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is not bounded`);
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function normalizeInput(raw) {
  const value = requireObject(raw, 'local process input');
  onlyKeys(value, new Set(['program', 'arguments', 'directory', 'environment', 'input', 'timeoutMs', 'maxOutputBytes']), 'local process input');
  if (typeof value.program !== 'string' || !PROGRAM.test(value.program) || value.program.includes('/') || value.program.includes('\\')) throw new TypeError('local process input.program is invalid');
  if (!Array.isArray(value.arguments) || value.arguments.length > 256) throw new TypeError('local process input.arguments is invalid');
  const argumentsList = value.arguments.map((entry, index) => boundedString(entry, `local process input.arguments[${index}]`, { allowEmpty: true, maxBytes: 65_536 }));
  const directory = boundedString(value.directory, 'local process input.directory', { maxBytes: 4_096 });
  if (!path.isAbsolute(directory)) throw new TypeError('local process input.directory must be absolute');
  const rawEnvironment = requireObject(value.environment, 'local process input.environment');
  if (Object.keys(rawEnvironment).length > 128) throw new TypeError('local process input.environment is too large');
  const environment = {};
  for (const [key, entry] of Object.entries(rawEnvironment)) {
    if (!ENVIRONMENT_NAME.test(key)) throw new TypeError(`local process input.environment.${key} name is invalid`);
    environment[key] = boundedString(entry, `local process input.environment.${key}`, { allowEmpty: true, maxBytes: 16_384 });
  }
  return {
    program: value.program,
    arguments: argumentsList,
    directory: path.resolve(directory),
    environment,
    input: value.input == null ? null : boundedString(value.input, 'local process input.input', { allowEmpty: true, maxBytes: MAX_INPUT_BYTES }),
    timeoutMs: integer(value.timeoutMs, 'local process input.timeoutMs', 1_000, MAX_TIMEOUT_MS),
    maxOutputBytes: integer(value.maxOutputBytes, 'local process input.maxOutputBytes', 1_024, MAX_OUTPUT_BYTES),
  };
}

function normalizePorts(raw) {
  const value = requireObject(raw, 'local process ports');
  onlyKeys(value, new Set(['pulse', 'readStop', 'writeStop']), 'local process ports');
  for (const name of ['pulse', 'readStop', 'writeStop']) if (typeof value[name] !== 'function') throw new TypeError(`local process ports.${name} must be a function`);
  return value;
}

function baseEnvironment() {
  const names = process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];
  const environment = {};
  for (const name of names) if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  return environment;
}

async function terminateTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: false, windowsHide: true });
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
      timer.unref?.();
      child.once('error', () => { clearTimeout(timer); resolve(); });
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); }
  catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const hard = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }, 1_000);
  hard.unref?.();
}

function emptyResult(reason) {
  const finishedAt = new Date().toISOString();
  return {
    exitCode: null,
    signal: null,
    timedOut: reason === 'timeout',
    aborted: reason === 'abort',
    outputTruncated: false,
    stdout: '',
    stderr: '',
    startedAt: null,
    finishedAt,
    lastOutputAt: null,
  };
}

function validStop(value) {
  if (value == null || value === 'abort' || value === 'timeout') return value;
  throw new Error('local process stop observation is invalid');
}

export async function runLocalProcess(rawInput, rawPorts) {
  const input = normalizeInput(rawInput);
  const ports = normalizePorts(rawPorts);
  await ports.pulse();
  const before = validStop(await ports.readStop());
  if (before) return emptyResult(before);

  const stdout = [];
  const stderr = [];
  const capture = { bytes: 0, truncated: false, lastOutputAt: null };
  const append = (list, chunk) => {
    const bytes = Buffer.from(chunk);
    capture.lastOutputAt = new Date().toISOString();
    if (capture.bytes >= input.maxOutputBytes) { capture.truncated = true; return; }
    const remaining = input.maxOutputBytes - capture.bytes;
    if (bytes.length > remaining) { list.push(bytes.subarray(0, remaining)); capture.bytes = input.maxOutputBytes; capture.truncated = true; return; }
    list.push(bytes);
    capture.bytes += bytes.length;
  };

  const child = spawn(input.program, input.arguments, {
    cwd: input.directory,
    env: { ...baseEnvironment(), ...input.environment },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let childSettled = false;
  let terminationSent = false;
  let stopReason = null;
  let controlFailure = null;
  let controlStopped = false;
  let controlTimer = null;
  let controlPending = null;
  let timeoutTimer = null;
  let timeoutPending = null;

  const terminateOwnedChild = async () => {
    if (terminationSent || childSettled || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
    terminationSent = true;
    await terminateTree(child.pid);
  };
  const controlCycle = async () => {
    try {
      await ports.pulse();
      const observed = validStop(await ports.readStop());
      if (observed && !stopReason) stopReason = observed;
      if (stopReason) await terminateOwnedChild();
    } catch (error) {
      controlFailure ??= error;
      await terminateOwnedChild();
    }
  };
  const scheduleControl = (delay = 0) => {
    controlTimer = setTimeout(() => {
      controlPending = controlCycle().finally(() => {
        controlPending = null;
        if (!controlStopped && !controlFailure) scheduleControl(CONTROL_INTERVAL_MS);
      });
    }, delay);
    controlTimer.unref?.();
  };
  const stopControl = async () => {
    controlStopped = true;
    if (controlTimer) clearTimeout(controlTimer);
    const pending = controlPending;
    if (pending) await pending;
  };

  let inputFailure = null;
  let settleInput;
  const inputCompletion = new Promise((resolve) => {
    let inputSettled = false;
    settleInput = (error = null) => {
      if (inputSettled) return;
      inputSettled = true;
      inputFailure = input.input == null ? null : error;
      resolve();
    };
    child.stdin.once('error', (error) => settleInput(error));
    child.stdin.once('close', () => settleInput(input.input == null ? null : new Error('local process input closed before delivery')));
  });
  const processCompletion = new Promise((resolve) => {
    const settleProcess = (exitCode, signal, error = null) => {
      if (childSettled) return;
      childSettled = true;
      resolve({ exitCode, signal, error });
    };
    child.stdout.on('data', (chunk) => append(stdout, chunk));
    child.stderr.on('data', (chunk) => append(stderr, chunk));
    child.once('error', (error) => settleProcess(null, null, error));
    child.once('close', (code, signal) => settleProcess(code, signal));
  });

  const startedAt = new Date().toISOString();
  scheduleControl();
  timeoutTimer = setTimeout(() => {
    timeoutPending = (async () => {
      if (childSettled || stopReason) return;
      stopReason = 'timeout';
      try { await ports.writeStop('timeout'); }
      catch (error) { controlFailure ??= error; }
      await terminateOwnedChild();
    })();
  }, input.timeoutMs);
  timeoutTimer.unref?.();

  try {
    child.stdin.end(input.input ?? undefined, () => settleInput(null));
    const outcome = await processCompletion;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (timeoutPending) await timeoutPending;
    await inputCompletion;
    await stopControl();
    if (controlFailure) throw new Error('local process activity could not be maintained');
    if (outcome.error) throw outcome.error;
    if (inputFailure) throw new Error('local process input could not be delivered');
    const reason = stopReason ?? validStop(await ports.readStop());
    const finishedAt = new Date().toISOString();
    return {
      exitCode: outcome.exitCode == null ? null : Math.max(-1, Math.min(255, Number(outcome.exitCode))),
      signal: outcome.signal == null ? null : String(outcome.signal).slice(0, 128),
      timedOut: reason === 'timeout',
      aborted: reason === 'abort',
      outputTruncated: capture.truncated,
      stdout: Buffer.concat(stdout).toString('base64'),
      stderr: Buffer.concat(stderr).toString('base64'),
      startedAt,
      finishedAt,
      lastOutputAt: capture.lastOutputAt,
    };
  } finally {
    await stopControl();
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (timeoutPending) await timeoutPending;
    if (!childSettled) await terminateOwnedChild();
  }
}
