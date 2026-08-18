import { spawn } from 'node:child_process';
import { PolicyError } from '../errors.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

const DEFAULT_OUTPUT_LIMIT = 512 * 1024;
const DEFAULT_ACTIVITY_INTERVAL_MS = 30_000;
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
  #sandbox;

  constructor({ sourceEnv = process.env, faultInjector = null, sandboxProvider = null } = {}) {
    this.#sourceEnv = sourceEnv;
    this.#faults = faultInjector;
    this.#sandbox = sandboxProvider;
  }

  sandboxStatus() {
    return this.#sandbox?.inspect?.() ?? {
      provider: 'none',
      configured: false,
      verified: false,
      verification: 'unavailable',
      reason: 'no sandbox provider attached to deterministic process runner',
    };
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
    activityIntervalMs = DEFAULT_ACTIVITY_INTERVAL_MS,
    operation = null,
    sandbox = null,
  }) {
    if (typeof executable !== 'string' || executable.length === 0) throw new PolicyError('deterministic operation executable is missing');
    if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new PolicyError('deterministic operation args must be structural strings');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 28_800_000) throw new PolicyError('deterministic operation timeout is out of range');
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16_777_216) throw new PolicyError('deterministic operation output limit is out of range');
    if (!Number.isInteger(activityIntervalMs) || activityIntervalMs < 10 || activityIntervalMs > 300_000) throw new PolicyError('deterministic activity interval is out of range');

    const env = boundedEnvironment(this.#sourceEnv, environment.pass ?? [], environment.set ?? {});
    let launch = { executable, args, cwd, environment: env, provider: 'direct' };
    if (sandbox?.required === true) {
      const status = this.sandboxStatus();
      if (!status.verified || !this.#sandbox?.prepareSpawn) {
        throw new PolicyError(`deterministic operation ${operation ?? 'unknown'} executes repository code and requires a verified sandbox provider; none is active`);
      }
      launch = await this.#sandbox.prepareSpawn({ executable, args, cwd, environment: env, sandbox });
    }

    const child = spawn(
      launch.executable,
      launch.args,
      containedSpawnOptions({ cwd: launch.cwd, env: launch.environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const deadlineAt = new Date(startedAtMs + timeoutMs).toISOString();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let lastOutputAt = null;
    let lastActivityEmitAt = 0;
    let activityError = null;
    let activityQueue = Promise.resolve();

    const emitActivity = (kind, { force = false, stream = null, bytes = null, processAlive = child.exitCode == null } = {}) => {
      if (typeof onActivity !== 'function') return;
      const atMs = Date.now();
      if (!force && lastActivityEmitAt !== 0 && atMs - lastActivityEmitAt < activityIntervalMs) return;
      lastActivityEmitAt = atMs;
      const at = new Date(atMs).toISOString();
      const payload = {
        kind,
        at,
        startedAt,
        elapsedMs: Math.max(0, atMs - startedAtMs),
        lastOutputAt,
        deadlineAt,
        timeoutMs,
        processAlive,
        sandboxProvider: launch.provider ?? 'direct',
      };
      if (stream) payload.stream = stream;
      if (bytes != null) payload.bytes = bytes;
      activityQueue = activityQueue.then(async () => {
        if (activityError) return;
        try { await onActivity(payload); }
        catch (error) { activityError = error; }
      });
    };

    emitActivity('started', { force: true, processAlive: true });
    const heartbeat = typeof onActivity === 'function'
      ? setInterval(() => emitActivity('heartbeat', { force: true, processAlive: child.exitCode == null }), activityIntervalMs)
      : null;
    heartbeat?.unref?.();

    const observe = (stream, chunk) => {
      lastOutputAt = new Date().toISOString();
      emitActivity('output', { stream, bytes: Buffer.byteLength(chunk) });
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
      if (heartbeat) clearInterval(heartbeat);
      if (termination) await termination;
    });

    emitActivity('finished', { force: true, processAlive: false });
    await activityQueue;
    if (activityError) throw activityError;

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
      sandboxProvider: launch.provider ?? 'direct',
    };
  }
}
