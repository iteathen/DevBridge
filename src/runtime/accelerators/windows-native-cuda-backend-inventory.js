import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COMPUTE_TOPOLOGY } from '../compute-capabilities.js';
import {
  ACCELERATOR_BACKEND_CHECK,
  ACCELERATOR_BACKEND_CHECK_STATE,
  ACCELERATOR_BACKEND_REASON,
  createAcceleratorBackendObservation,
} from '../accelerator-backend-inventory.js';

const MIN_WINDOWS_BUILD = 19045;
const OUTPUT_LIMIT = 64 * 1024;
const TIMEOUT_MS = 15_000;
const ADAPTER_GENERATION = 'windows-native-cuda-backend-inventory-v1';

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

function windowsBuild(release) {
  const match = /^(?:\d+)\.(?:\d+)\.(\d+)(?:\.|$)/u.exec(String(release ?? ''));
  if (!match) return null;
  const build = Number(match[1]);
  return Number.isSafeInteger(build) ? build : null;
}

async function regularFile(candidate) {
  try {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return realpath(candidate);
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function localCandidates(env) {
  const root = env.SystemRoot || env.WINDIR;
  const programFiles = unique([env.ProgramW6432, env.ProgramFiles]);
  return Object.freeze({
    runtime: unique(root ? [path.win32.join(root, 'System32', 'nvcuda.dll')] : []),
    accelerator: unique([
      ...(root ? [path.win32.join(root, 'System32', 'nvidia-smi.exe')] : []),
      ...programFiles.map((base) => path.win32.join(base, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')),
    ]),
  });
}

async function defaultResolveLocal(kind, env) {
  const candidates = localCandidates(env)[kind] ?? [];
  for (const candidate of candidates) {
    const resolved = await regularFile(candidate);
    if (resolved) return resolved;
  }
  return null;
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

export class WindowsNativeCudaBackendInventory {
  #invoke;
  #resolveLocal;
  #platform;
  #arch;
  #release;
  #env;

  constructor({
    invoke,
    resolveLocal = defaultResolveLocal,
    platform = process.platform,
    arch = process.arch,
    release = os.release(),
    env = process.env,
  } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('accelerator backend inventory invoke must be a function');
    if (typeof resolveLocal !== 'function') throw new TypeError('accelerator backend inventory local resolver must be a function');
    this.#invoke = invoke;
    this.#resolveLocal = resolveLocal;
    this.#platform = platform;
    this.#arch = arch;
    this.#release = release;
    this.#env = env;
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
    const facts = { adapter: ADAPTER_GENERATION, platform: this.#platform, arch: this.#arch, release: String(this.#release ?? '') };

    if (this.#platform !== 'win32' || this.#arch !== 'x64') {
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
      checks[ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT] = READY;
    }

    const runtimeLibrary = await this.#resolveLocal('runtime', this.#env);
    if (!runtimeLibrary) {
      checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = blocked(ACCELERATOR_BACKEND_REASON.RUNTIME_UNAVAILABLE);
    } else {
      checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = READY;
      facts.runtimePresent = true;
    }

    const acceleratorExecutable = await this.#resolveLocal('accelerator', this.#env);
    if (!acceleratorExecutable) {
      checks[ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME] = unknown(ACCELERATOR_BACKEND_REASON.ACCELERATOR_OBSERVATION_FAILED);
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
          const eligible = accelerators.some((entry) => entry.computeMajor > 0 || entry.computeMinor > 0);
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
