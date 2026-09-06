import { createHash } from 'node:crypto';
import { access, constants, lstat, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import { COMPUTE_TOPOLOGY } from '../compute-capabilities.js';
import {
  ACCELERATOR_BACKEND_CHECK,
  ACCELERATOR_BACKEND_CHECK_STATE,
  ACCELERATOR_BACKEND_REASON,
  createAcceleratorBackendObservation,
} from '../accelerator-backend-inventory.js';

const OUTPUT_LIMIT = 64 * 1024;
const TIMEOUT_MS = 15_000;
const ADAPTER_GENERATION = 'linux-native-cuda-backend-inventory-v1';
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64']);
const TRUSTED_EXECUTABLE_ROOTS = Object.freeze(['/usr/bin/', '/usr/sbin/', '/usr/lib/', '/bin/', '/sbin/']);

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

function trustedPath(value) {
  return TRUSTED_EXECUTABLE_ROOTS.some((root) => value.startsWith(root));
}

async function trustedRegularFile(candidate) {
  try {
    const resolved = await realpath(candidate);
    if (!trustedPath(resolved)) return null;
    const info = await stat(resolved);
    return info.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

async function defaultResolveExecutable(kind) {
  const candidates = kind === 'loader'
    ? ['/sbin/ldconfig', '/usr/sbin/ldconfig', '/usr/bin/ldconfig']
    : ['/usr/bin/nvidia-smi', '/bin/nvidia-smi'];
  for (const candidate of candidates) {
    const resolved = await trustedRegularFile(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function cudaDriverLibraries(text) {
  return Object.freeze(normalizedOutput(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^libcuda\.so\.1\s+\(.+\)\s+=>\s+\S+/u.test(line))
    .sort());
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

async function accessibleCharacterDevice(candidate) {
  try {
    const info = await lstat(candidate);
    if (!info.isCharacterDevice() || info.isSymbolicLink()) return false;
    await access(candidate, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultObserveDeviceAccess() {
  const controlReady = await accessibleCharacterDevice('/dev/nvidiactl');
  let entries;
  try {
    entries = await readdir('/dev', { withFileTypes: true });
  } catch {
    return Object.freeze({ observed: false, controlReady: false, deviceCount: 0 });
  }
  const names = entries
    .filter((entry) => entry.isCharacterDevice() && /^nvidia\d+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  let deviceCount = 0;
  for (const name of names) if (await accessibleCharacterDevice(`/dev/${name}`)) deviceCount += 1;
  return Object.freeze({ observed: true, controlReady, deviceCount });
}

function opaqueSubject() {
  const digest = createHash('sha256').update('devbridge/accelerator-backend-subject-v1\0').update(ADAPTER_GENERATION).digest('hex');
  return `accelerator-backend-${digest.slice(0, 32)}`;
}

function opaqueGeneration(facts) {
  const digest = createHash('sha256').update('devbridge/accelerator-backend-generation-v1\0').update(JSON.stringify(facts)).digest('hex');
  return `backend-generation-${digest.slice(0, 32)}`;
}

export class LinuxNativeCudaBackendInventory {
  #invoke;
  #resolveExecutable;
  #observeDeviceAccess;
  #platform;
  #architecture;
  #release;
  #effectiveUid;

  constructor({
    invoke,
    resolveExecutable = defaultResolveExecutable,
    observeDeviceAccess = defaultObserveDeviceAccess,
    platform = process.platform,
    architecture = process.arch,
    release = os.release(),
    effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : null,
  } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('accelerator backend inventory invoke must be a function');
    if (typeof resolveExecutable !== 'function') throw new TypeError('accelerator backend inventory executable resolver must be a function');
    if (typeof observeDeviceAccess !== 'function') throw new TypeError('accelerator backend inventory device observer must be a function');
    this.#invoke = invoke;
    this.#resolveExecutable = resolveExecutable;
    this.#observeDeviceAccess = observeDeviceAccess;
    this.#platform = platform;
    this.#architecture = architecture;
    this.#release = release;
    this.#effectiveUid = effectiveUid;
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
    const facts = {
      adapter: ADAPTER_GENERATION,
      platform: this.#platform,
      architecture: this.#architecture,
      release: String(this.#release ?? ''),
    };

    if (this.#platform !== 'linux' || !SUPPORTED_ARCHITECTURES.has(this.#architecture)) {
      checks[ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM] = blocked(ACCELERATOR_BACKEND_REASON.PLATFORM_UNSUPPORTED);
      return createAcceleratorBackendObservation({
        subject: opaqueSubject(), generation: opaqueGeneration({ ...facts, checks }), api: 'cuda',
        topology: COMPUTE_TOPOLOGY.HOST_RETAINED, checks,
      });
    }
    checks[ACCELERATOR_BACKEND_CHECK.HOST_PLATFORM] = READY;

    const loaderExecutable = await this.#resolveExecutable('loader');
    if (!loaderExecutable) {
      checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = unknown(ACCELERATOR_BACKEND_REASON.RUNTIME_OBSERVATION_FAILED);
    } else {
      const libraries = await this.#run(loaderExecutable, ['-p']);
      if (!libraries.ok) {
        checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = unknown(ACCELERATOR_BACKEND_REASON.RUNTIME_OBSERVATION_FAILED);
      } else {
        const driverLibraries = cudaDriverLibraries(libraries.stdout);
        if (driverLibraries.length === 0) {
          checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = blocked(ACCELERATOR_BACKEND_REASON.RUNTIME_UNAVAILABLE);
        } else {
          checks[ACCELERATOR_BACKEND_CHECK.BACKEND_RUNTIME] = READY;
          facts.driverLibrary = createHash('sha256').update(driverLibraries.join('\n')).digest('hex');
        }
      }
    }

    let deviceAccess;
    try {
      deviceAccess = await this.#observeDeviceAccess();
    } catch {
      deviceAccess = null;
    }
    if (!deviceAccess?.observed) {
      checks[ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT] = unknown(ACCELERATOR_BACKEND_REASON.ENVIRONMENT_OBSERVATION_FAILED);
    } else {
      facts.deviceCount = deviceAccess.deviceCount;
      checks[ACCELERATOR_BACKEND_CHECK.BACKEND_ENVIRONMENT] = deviceAccess.controlReady && deviceAccess.deviceCount > 0
        ? READY
        : blocked(ACCELERATOR_BACKEND_REASON.ENVIRONMENT_UNAVAILABLE);
    }

    const acceleratorExecutable = await this.#resolveExecutable('accelerator');
    if (!acceleratorExecutable) {
      checks[ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME] = unknown(ACCELERATOR_BACKEND_REASON.ACCELERATOR_OBSERVATION_FAILED);
    } else if (!Number.isInteger(this.#effectiveUid) || this.#effectiveUid === 0) {
      // NVIDIA documents that nvidia-smi may modify Linux device files when run as root.
      // Preserve this inventory as read-only by refusing that probe in an elevated process.
      checks[ACCELERATOR_BACKEND_CHECK.ACCELERATOR_RUNTIME] = unknown(ACCELERATOR_BACKEND_REASON.ACCELERATOR_OBSERVATION_FAILED);
      facts.acceleratorProbe = 'not-run-elevated';
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
          const eligible = accelerators.some((entry) => entry.computeMajor > 0 && entry.driverMajor > 0);
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
