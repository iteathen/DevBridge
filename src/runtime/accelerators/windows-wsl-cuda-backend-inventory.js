import { createHash } from 'node:crypto';
import os from 'node:os';
import { COMPUTE_TOPOLOGY } from '../compute-capabilities.js';
import {
  ACCELERATOR_BACKEND_CHECK,
  ACCELERATOR_BACKEND_CHECK_STATE,
  ACCELERATOR_BACKEND_REASON,
  createAcceleratorBackendObservation,
} from '../accelerator-backend-inventory.js';
import { WINDOWS_SYSTEM_TARGET, resolveWindowsSystemTarget } from '../windows-system-targets.js';

const MIN_WINDOWS_BUILD = 19044;
const MIN_DRIVER_MAJOR = 495;
const MIN_COMPUTE_MAJOR = 6;
const OUTPUT_LIMIT = 64 * 1024;
const TIMEOUT_MS = 15_000;
const ADAPTER_GENERATION = 'windows-wsl-cuda-backend-inventory-v1';
const WSL_NOT_INSTALLED = /\bwindows subsystem for linux is not installed\b/iu;

const READY = Object.freeze({ state: ACCELERATOR_BACKEND_CHECK_STATE.READY, reason: null });
const UNKNOWN_TRANSPORT = Object.freeze({ state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN, reason: ACCELERATOR_BACKEND_REASON.TRANSPORT_UNPROVEN });
const UNKNOWN_SECURITY = Object.freeze({ state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN, reason: ACCELERATOR_BACKEND_REASON.SECURITY_UNPROVEN });

function blocked(reason) { return Object.freeze({ state: ACCELERATOR_BACKEND_CHECK_STATE.BLOCKED, reason }); }
function unknown(reason) { return Object.freeze({ state: ACCELERATOR_BACKEND_CHECK_STATE.UNKNOWN, reason }); }

function normalizedOutput(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/u, '')
    .replace(/\u0000/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r/g, '')
    .trim();
}

function successful(result) {
  return result && result.exitCode === 0 && result.timedOut !== true && result.aborted !== true && result.outputTruncated !== true;
}

function explicitRuntimeUnavailable(result) {
  if (!result || result.ok) return false;
  return WSL_NOT_INSTALLED.test(`${result.stdout}\n${result.stderr}`);
}

function windowsBuild(release) {
  const match = /^(?:\d+)\.(?:\d+)\.(\d+)(?:\.|$)/u.exec(String(release ?? ''));
  if (!match) return null;
  const build = Number(match[1]);
  return Number.isSafeInteger(build) ? build : null;
}

async function defaultResolveExecutable(kind) {
  if (kind === 'runtime') return resolveWindowsSystemTarget(WINDOWS_SYSTEM_TARGET.WSL_RUNTIME);
  if (kind === 'accelerator') return resolveWindowsSystemTarget(WINDOWS_SYSTEM_TARGET.NVIDIA_SMI);
  throw new TypeError('Windows WSL CUDA inventory local target is unsupported');
}

function wsl2Count(text) {
  let count = 0;
  for (const line of normalizedOutput(text).split('\n')) {
    if (/\s2\s*$/u.test(line)) count += 1;
  }
  return count;
}

function parseAccelerators(text) {
  const rows = [];
  for (const line of normalizedOutput(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [computeRaw, driverRaw, ...extra] = trimmed.split(',').map((value) => value.trim());
    if (extra.length > 0) return null;
    const compute = /^(\d+)\.(\d+)$/u.exec(computeRaw ?? '');
    const driver = /^(\d+)(?:\.\d+)*(?:[^\d].*)?$/u.exec(driverRaw ?? '');
    if (!compute || !driver) return null;
    rows.push(Object.freeze({
      computeMajor: Number(compute[1]),
      computeMinor: Number(compute[2]),
      driverMajor: Number(driver[1]),
      driverVersion: driverRaw,
    }));
  }
  return rows.length > 0 ? Object.freeze(rows) : null;
}

function opaqueSubject() {
  const digest = createHash('sha256').update('devbridge/accelerator-backend-subject-v1\0').update(ADAPTER_GENERATION).digest('hex');
  return `accelerator-backend-${digest.slice(0, 32)}`;
}

function opaqueGeneration(facts) {
  const digest = createHash('sha256').update('devbridge/accelerator-backend-generation-v1\0').update(JSON.stringify(facts)).digest('hex');
  return `backend-generation-${digest.slice(0, 32)}`;
}

export class WindowsWslCudaBackendInventory {
  #invoke;
  #resolveExecutable;
  #platform;
  #release;

  constructor({
    invoke,
    resolveExecutable = defaultResolveExecutable,
    platform = process.platform,
    release = os.release(),
  } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('accelerator backend inventory invoke must be a function');
    if (typeof resolveExecutable !== 'function') throw new TypeError('accelerator backend inventory executable resolver must be a function');
    this.#invoke = invoke;
    this.#resolveExecutable = resolveExecutable;
    this.#platform = platform;
    this.#release = release;
  }

  async #run(executable, argumentsList) {
    try {
      const result = await this.#invoke({
        executable,
        arguments: argumentsList,
        timeoutMs: TIMEOUT_MS,
        maxOutputBytes: OUTPUT_LIMIT,
      });
      return Object.freeze({ ok: successful(result), stdout: normalizedOutput(result?.stdout), stderr: normalizedOutput(result?.stderr) });
    } catch {
      return Object.freeze({ ok: false, stdout: '', stderr: '' });
    }
  }

  async observe() {
    const checks = {
      [ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM]: unknown(ACCELERATOR_BACKEND_REASON.PLATFORM_OBSERVATION_FAILED),
      [ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME]: unknown(ACCELERATOR_BACKEND_REASON.RUNTIME_OBSERVATION_FAILED),
      [ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT]: unknown(ACCELERATOR_BACKEND_REASON.ENVIRONMENT_OBSERVATION_FAILED),
      [ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME]: unknown(ACCELERATOR_BACKEND_REASON.ACCELERATOR_OBSERVATION_FAILED),
      [ACCELERATOR_BACKEND_CHECK.BOUNDARY_TRANSPORT]: UNKNOWN_TRANSPORT,
      [ACCELERATOR_BACKEND_CHECK.SECURITY_BOUNDARY]: UNKNOWN_SECURITY,
    };
    const facts = { adapter: ADAPTER_GENERATION, platform: this.#platform, release: String(this.#release ?? '') };

    if (this.#platform !== 'win32') {
      checks[ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM] = blocked(ACCELERATOR_BACKEND_REASON.PLATFORM_UNSUPPORTED);
      return createAcceleratorBackendObservation({
        subject: opaqueSubject(), generation: opaqueGeneration({ ...facts, checks }), api: 'cuda',
        topology: COMPUTE_TOPOLOGY.HOST_RETAINED, checks,
      });
    }

    const build = windowsBuild(this.#release);
    facts.build = build;
    if (build == null) {
      checks[ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM] = unknown(ACCELERATOR_BACKEND_REASON.PLATFORM_OBSERVATION_FAILED);
    } else if (build < MIN_WINDOWS_BUILD) {
      checks[ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM] = blocked(ACCELERATOR_BACKEND_REASON.PLATFORM_UNSUPPORTED);
    } else {
      checks[ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM] = READY;
    }

    const runtimeExecutable = await this.#resolveExecutable('runtime');
    if (!runtimeExecutable) {
      checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = blocked(ACCELERATOR_BACKEND_REASON.RUNTIME_UNAVAILABLE);
      checks[ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT] = blocked(ACCELERATOR_BACKEND_REASON.ENVIRONMENT_UNAVAILABLE);
    } else {
      const [status, version] = await Promise.all([
        this.#run(runtimeExecutable, ['--status']),
        this.#run(runtimeExecutable, ['--version']),
      ]);
      if (explicitRuntimeUnavailable(status) || explicitRuntimeUnavailable(version)) {
        checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = blocked(ACCELERATOR_BACKEND_REASON.RUNTIME_UNAVAILABLE);
        checks[ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT] = blocked(ACCELERATOR_BACKEND_REASON.ENVIRONMENT_UNAVAILABLE);
        facts.runtimeUnavailable = true;
      } else if (status.ok || version.ok) {
        checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = READY;
        facts.runtime = createHash('sha256').update(`${status.stdout}\n${version.stdout}`).digest('hex');
        const environments = await this.#run(runtimeExecutable, ['--list', '--verbose']);
        if (!environments.ok) {
          checks[ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT] = unknown(ACCELERATOR_BACKEND_REASON.ENVIRONMENT_OBSERVATION_FAILED);
        } else {
          const count = wsl2Count(environments.stdout);
          facts.environmentCount = count;
          checks[ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT] = count > 0
            ? READY
            : blocked(ACCELERATOR_BACKEND_REASON.ENVIRONMENT_UNAVAILABLE);
        }
      } else {
        checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = unknown(ACCELERATOR_BACKEND_REASON.RUNTIME_OBSERVATION_FAILED);
      }
    }

    const acceleratorExecutable = await this.#resolveExecutable('accelerator');
    if (!acceleratorExecutable) {
      checks[ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME] = blocked(ACCELERATOR_BACKEND_REASON.ACCELERATOR_UNAVAILABLE);
    } else {
      const observed = await this.#run(acceleratorExecutable, [
        '--query-gpu=compute_cap,driver_version',
        '--format=csv,noheader,nounits',
      ]);
      if (!observed.ok) {
        checks[ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME] = unknown(ACCELERATOR_BACKEND_REASON.ACCELERATOR_OBSERVATION_FAILED);
      } else {
        const accelerators = parseAccelerators(observed.stdout);
        if (!accelerators) {
          checks[ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME] = unknown(ACCELERATOR_BACKEND_REASON.ACCELERATOR_OBSERVATION_FAILED);
        } else {
          facts.accelerators = accelerators;
          const eligible = accelerators.some((entry) => entry.computeMajor >= MIN_COMPUTE_MAJOR && entry.driverMajor >= MIN_DRIVER_MAJOR);
          checks[ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME] = eligible
            ? READY
            : blocked(ACCELERATOR_BACKEND_REASON.ACCELERATOR_INCOMPATIBLE);
        }
      }
    }

    return createAcceleratorBackendObservation({
      subject: opaqueSubject(), generation: opaqueGeneration({ ...facts, checks }), api: 'cuda',
      topology: COMPUTE_TOPOLOGY.HOST_RETAINED, checks,
    });
  }
}
