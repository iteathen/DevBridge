import { spawn } from 'node:child_process';
import { PolicyError } from '../errors.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

const DEFAULT_OUTPUT_LIMIT = 512 * 1024;
const FAULT_TRUNCATE_BYTES = 32;

function appendTail(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  if (combined.length <= maxBytes) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - maxBytes), truncated: true };
}

function boundedEnvironment(source, pass = [], set = {}) {
  const env = {};
  for (const name of pass) if (source[name] != null) env[name] = source[name];
  Object.assign(env, set);
  env.GIT_TERMINAL_PROMPT = '0';
  env.PATCH_POLLER_NONINTERACTIVE = '1';
  env.NO_COLOR ??= '1';
  return env;
}

function truncateFault(buffer) {
  return buffer.length <= FAULT_TRUNCATE_BYTES ? buffer : buffer.subarray(buffer.length - FAULT_TRUNCATE_BYTES);
}

export class DeterministicProcessRunner {
  #sourceEnv;
  #faults;

  constructor({ sourceEnv = process.env, faultInjector = null } = {}) {
    this.#sourceEnv = sourceEnv;
    this.#faults = faultInjector;
  }

  async run({
    executable,
    args = [],
    cwd,
    timeoutMs = 120_000,
    maxOutputBytes = DEFAULT_OUTPUT_LIMIT,
    environment = { pass: [], set: {} },
    stdin = null,
    onActivity = null,
    operation = null,
  }) {
    if (typeof executable !== 'string' || executable.length === 0) throw new PolicyError('deterministic operation executable is missing');
    if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new PolicyError('deterministic operation args must be structural strings');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 28_800_000) throw new PolicyError('deterministic operation timeout is out of range');
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16_777_216) throw new PolicyError('deterministic operation output limit is out of range');

    const env = boundedEnvironment(this.#sourceEnv, environment.pass ?? [], environment.set ?? {});
    const child = spawn(executable, args, containedSpawnOptions({ cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let lastOutputAt = null;
    const observe = (stream, chunk) => {
      lastOutputAt = new Date().toISOString();
      onActivity?.({ stream, at: lastOutputAt, bytes: Buffer.byteLength(chunk) });
    };
    child.stdout.on('data', (chunk) => {
      const next = appendTail(stdout, chunk, maxOutputBytes);
      stdout = next.buffer;
      outputTruncated ||= next.truncated;
      observe('stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      const next = appendTail(stderr, chunk, maxOutputBytes);
      stderr = next.buffer;
      outputTruncated ||= next.truncated;
      observe('stderr', chunk);
    });
    if (stdin == null) child.stdin.end(); else child.stdin.end(String(stdin));

    let timedOut = false;
    let termination = null;
    const startedAt = new Date().toISOString();
    const timer = setTimeout(() => {
      timedOut = true;
      termination = terminateProcessTree(child);
    }, timeoutMs);
    timer.unref?.();
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }).finally(async () => {
      clearTimeout(timer);
      if (termination) await termination;
    });

    const fault = this.#faults?.throwIfTriggered('process.after-exit', { operation }) ?? null;
    if (fault?.action === 'timeout') timedOut = true;
    if (fault?.action === 'truncate-output') {
      stdout = truncateFault(stdout);
      stderr = truncateFault(stderr);
      outputTruncated = true;
    }

    return {
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      outputTruncated,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      startedAt,
      finishedAt: new Date().toISOString(),
      lastOutputAt,
    };
  }
}
