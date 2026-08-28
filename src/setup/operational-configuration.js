import { createHash, randomUUID } from 'node:crypto';
import { lstat, link, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const SETUP_OPERATIONAL_CONFIGURATION_REQUEST_PROTOCOL = 'devbridge/setup-operational-configuration-request-v1';
export const SETUP_OPERATIONAL_CONFIGURATION_RESULT_PROTOCOL = 'devbridge/setup-operational-configuration-result-v1';

const RECORD_PROTOCOL = 'devbridge/setup-operational-configuration-record-v1';
const DIGEST = /^[0-9a-f]{64}$/u;
const TARGET = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const OWNER = /^[A-Za-z0-9_.-]+$/u;
const ACTOR = /^\d+$/u;
const STAGING = /^\.config-[0-9a-f-]{36}\.tmp$/u;
const CONFIG_BYTES = 512 * 1024;
const RECORD_BYTES = 1024 * 1024;
const MAX_TARGETS = 4096;
const MAX_ACTORS = 64;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function uniqueSorted(raw, pattern, maximum, name, { lower = false } = {}) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > maximum) throw new TypeError(`${name} is invalid`);
  const values = raw.map((entry, index) => {
    if (typeof entry !== 'string' || !pattern.test(entry)) throw new TypeError(`${name}[${index}] is invalid`);
    return lower ? entry.toLowerCase() : entry;
  });
  if (new Set(values.map((entry) => entry.toLowerCase())).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
}

export function normalizeSetupOperationalConfigurationRequest(raw) {
  const value = exactObject(raw, new Set(['protocol', 'targets', 'submitters', 'owners']), 'setup operational configuration request');
  if (value.protocol !== SETUP_OPERATIONAL_CONFIGURATION_REQUEST_PROTOCOL) throw new TypeError('setup operational configuration request protocol is unsupported');
  const targets = uniqueSorted(value.targets, TARGET, MAX_TARGETS, 'setup operational configuration targets');
  const submitters = uniqueSorted(value.submitters, ACTOR, MAX_ACTORS, 'setup operational configuration submitters');
  const owners = uniqueSorted(value.owners, OWNER, MAX_TARGETS, 'setup operational configuration owners', { lower: true });
  const acceptedOwners = new Set(owners);
  if (targets.some((target) => !acceptedOwners.has(target.split('/')[0].toLowerCase()))) {
    throw new TypeError('setup operational configuration target owner is not accepted');
  }
  return Object.freeze({ protocol: SETUP_OPERATIONAL_CONFIGURATION_REQUEST_PROTOCOL, targets, submitters, owners });
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function operationalConfig(home, request, validate) {
  const candidate = {
    version: 1,
    github: {
      queueRepositories: [...request.targets],
      taskLabel: 'devbridge:ready',
      trustedActorIds: [...request.submitters],
      auth: {
        mode: 'auto',
        environmentVariables: ['DEVBRIDGE_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
        githubCliExecutable: 'gh',
        hostname: 'github.com',
      },
      apiVersion: '2026-03-10',
      pollIntervalMs: 60_000,
      rateLimit: { reserveRatio: 0.2, minimumReserve: 250, emergencyReserve: 25, mutationIntervalMs: 1_100 },
    },
    workspace: {
      root: path.join(home, 'workspaces'),
      allowCreate: true,
      allowedOwners: [...request.owners],
      externalReadRoots: [],
      baselineChannels: {},
      defaultBaselineChannel: null,
    },
    state: { directory: path.join(home, 'state') },
    contextRollover: {
      enabled: true,
      unit: 'bytes',
      capacityUnits: 1_000_000,
      softRatio: 0.55,
      preferredRatio: 0.65,
      hardRatio: 0.75,
      maxHandoffBytes: 32_768,
      maxRetained: 8,
    },
    coordination: {
      enabled: false,
      handle: 'agent',
      leaseTtlMs: 1_200_000,
      heartbeatIntervalMs: 300_000,
      clockSkewMs: 60_000,
      trustedPeers: [],
    },
    git: {
      executable: 'git',
      cloneBaseUrl: 'https://github.com',
      commandTimeoutMs: 120_000,
      fetchTimeoutMs: 300_000,
    },
    execution: {
      enabled: true,
      controllerPlansEnabled: true,
      modelAdaptersEnabled: false,
      defaultTool: null,
      maxConcurrentTasks: 1,
      maxTurns: 8,
      allowUncontainedTools: false,
      toolOnboarding: {
        enabled: false,
        manifestDirectory: null,
        autoIntegrate: [],
        maxHelpBytes: 262_144,
        probeTimeoutMs: 15_000,
      },
      decisionAuthorities: {},
      decisionApprovalTtlMs: 86_400_000,
      architectureGateFileThreshold: 20,
      architectureOwnerThreshold: 4,
      faultInjection: { enabled: false, rules: [] },
    },
    publication: { autoPushTaskBranches: false, forceNoOpPublication: false, branchPrefix: 'devbridge' },
    daemon: { errorBackoffMs: 60_000 },
    status: { progressIntervalMs: 300_000, maxCommentBytes: 48_000 },
    tools: {},
  };
  const normalized = validate(candidate);
  if (normalized?.execution?.enabled !== true
      || normalized.execution.controllerPlansEnabled !== true
      || normalized.execution.modelAdaptersEnabled !== false
      || normalized.execution.allowUncontainedTools !== false
      || normalized.execution.toolOnboarding?.enabled !== false
      || normalized.publication?.autoPushTaskBranches !== false) {
    throw new Error('operational configuration validation changed its safety policy');
  }
  const content = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(content, 'utf8') > CONFIG_BYTES) throw new Error('operational configuration exceeds its bound');
  return Object.freeze({ value: normalized, content, digest: digest(Buffer.from(content, 'utf8')) });
}

function normalizeRecord(raw) {
  const value = exactObject(raw, new Set(['protocol', 'phase', 'previous', 'target', 'content', 'staging', 'updatedAt']), 'setup operational configuration record');
  if (value.protocol !== RECORD_PROTOCOL || !['planned', 'ready'].includes(value.phase)) throw new TypeError('setup operational configuration record is invalid');
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new TypeError('setup operational configuration record timestamp is invalid');
  if (value.phase === 'ready') {
    if (!DIGEST.test(value.target ?? '') || value.previous != null || value.content != null || value.staging != null) {
      throw new TypeError('ready operational configuration record is invalid');
    }
    return Object.freeze({ protocol: RECORD_PROTOCOL, phase: 'ready', previous: null, target: value.target, content: null, staging: null, updatedAt: value.updatedAt });
  }
  if ((value.previous != null && !DIGEST.test(value.previous)) || !DIGEST.test(value.target ?? '')
      || typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') < 2
      || Buffer.byteLength(value.content, 'utf8') > CONFIG_BYTES || digest(Buffer.from(value.content, 'utf8')) !== value.target
      || typeof value.staging !== 'string' || !STAGING.test(value.staging)) {
    throw new TypeError('planned operational configuration record is invalid');
  }
  return Object.freeze({
    protocol: RECORD_PROTOCOL,
    phase: 'planned',
    previous: value.previous ?? null,
    target: value.target,
    content: value.content,
    staging: value.staging,
    updatedAt: value.updatedAt,
  });
}

function samePath(left, right, platform) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function realDirectory(location, name) {
  const info = await lstat(location);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} must be a real directory`);
  return realpath(location);
}

async function preparePaths(home, platform) {
  const root = path.resolve(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realDirectory(root, 'operational configuration home');
  if (!samePath(root, canonicalRoot, platform)) throw new Error('operational configuration home uses filesystem indirection');
  const state = path.join(root, 'state');
  const control = path.join(state, 'setup-operational-configuration');
  await mkdir(control, { recursive: true, mode: 0o700 });
  const canonicalState = await realDirectory(state, 'operational configuration state');
  const canonicalControl = await realDirectory(control, 'operational configuration control');
  if (!samePath(state, canonicalState, platform) || !samePath(control, canonicalControl, platform)) {
    throw new Error('operational configuration control uses filesystem indirection');
  }
  return Object.freeze({ root, config: path.join(root, 'config.json'), control, record: path.join(control, 'state.json'), platform });
}

async function boundedFile(location, maximum, name, platform) {
  let handle;
  try {
    const before = await lstat(location);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > maximum) throw new Error(`${name} must be one bounded real file`);
    const canonical = await realpath(location);
    if (!samePath(canonical, location, platform)) throw new Error(`${name} uses filesystem indirection`);
    handle = await open(location, 'r');
    const held = await handle.stat();
    if (!held.isFile() || held.size < 2 || held.size > maximum) throw new Error(`${name} must be one bounded real file`);
    const bytes = await handle.readFile();
    const after = await lstat(location);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== held.dev || after.ino !== held.ino
        || after.size !== held.size || bytes.length !== held.size || bytes.length < 2 || bytes.length > maximum
        || !samePath(await realpath(location), location, platform)) {
      throw new Error(`${name} changed during observation`);
    }
    return Object.freeze({ bytes, digest: digest(bytes) });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function loadRecord(paths) {
  const observed = await boundedFile(paths.record, RECORD_BYTES, 'operational configuration record', paths.platform);
  if (observed == null) return null;
  let parsed;
  try { parsed = JSON.parse(observed.bytes.toString('utf8')); }
  catch { throw new Error('operational configuration record is not valid JSON'); }
  return normalizeRecord(parsed);
}

async function writeNewFile(location, content) {
  const handle = await open(location, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeRecord(paths, record) {
  const normalized = normalizeRecord(record);
  try {
    const current = await lstat(paths.record);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('operational configuration record target is invalid');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(paths.control, `.record-${randomUUID()}.tmp`);
  try {
    await writeNewFile(temporary, `${JSON.stringify(normalized)}\n`);
    await rename(temporary, paths.record);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return normalized;
}

async function observeConfiguration(paths) {
  const observed = await boundedFile(paths.config, CONFIG_BYTES, 'operational configuration', paths.platform);
  return observed;
}

function validateObservedConfiguration(observed, validate) {
  if (observed == null) throw new Error('operational configuration is unavailable');
  let raw;
  try { raw = JSON.parse(observed.bytes.toString('utf8')); }
  catch { throw new Error('operational configuration is not valid JSON'); }
  return validate(raw);
}

async function ensureStaging(paths, record) {
  const location = path.join(paths.root, record.staging);
  let observed = await boundedFile(location, CONFIG_BYTES, 'operational configuration staging file', paths.platform);
  if (observed == null) {
    await writeNewFile(location, record.content);
    observed = await boundedFile(location, CONFIG_BYTES, 'operational configuration staging file', paths.platform);
  }
  if (observed.digest !== record.target || observed.bytes.toString('utf8') !== record.content) {
    throw new Error('operational configuration staging identity changed');
  }
  return location;
}

async function removeStaging(location) {
  try {
    const info = await lstat(location);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('operational configuration staging target is invalid');
    await rm(location, { force: false });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function readyResult(changed, target) {
  return Object.freeze({
    protocol: SETUP_OPERATIONAL_CONFIGURATION_RESULT_PROTOCOL,
    ready: true,
    changed,
    executionEnabled: true,
    subject: target,
    blocker: null,
  });
}

export function createSetupOperationalConfiguration({
  home,
  validate,
  platform = process.platform,
} = {}, {
  now = () => new Date().toISOString(),
  id = randomUUID,
  fault = async () => {},
} = {}) {
  if (typeof home !== 'string' || home.length === 0 || home.includes('\0') || !path.isAbsolute(home)) throw new TypeError('operational configuration home is invalid');
  if (typeof validate !== 'function' || typeof now !== 'function' || typeof id !== 'function' || typeof fault !== 'function') {
    throw new TypeError('operational configuration dependencies are incomplete');
  }

  return Object.freeze({
    async reconcile(rawRequest) {
      const request = normalizeSetupOperationalConfigurationRequest(rawRequest);
      const paths = await preparePaths(home, platform);
      const desired = operationalConfig(paths.root, request, validate);
      let changed = false;

      for (let attempt = 0; attempt < 4; attempt += 1) {
        let record = await loadRecord(paths);
        let observed = await observeConfiguration(paths);

        if (record?.phase === 'planned') {
          if (observed?.digest !== record.target && (observed?.digest ?? null) !== record.previous) {
            throw new Error('operational configuration changed outside its planned transition');
          }
          const staging = await ensureStaging(paths, record);
          await fault('staged');
          observed = await observeConfiguration(paths);
          if (observed?.digest !== record.target) {
            if ((observed?.digest ?? null) !== record.previous) throw new Error('operational configuration predecessor changed before replacement');
            if (record.previous == null) {
              try { await link(staging, paths.config); }
              catch (error) {
                if (error?.code !== 'EEXIST') throw error;
              }
            } else {
              await rename(staging, paths.config);
            }
            changed = true;
          }
          await fault('effect');
          observed = await observeConfiguration(paths);
          if (observed?.digest !== record.target) throw new Error('operational configuration replacement did not verify');
          validateObservedConfiguration(observed, validate);
          await removeStaging(staging);
          record = await writeRecord(paths, {
            protocol: RECORD_PROTOCOL,
            phase: 'ready',
            previous: null,
            target: record.target,
            content: null,
            staging: null,
            updatedAt: now(),
          });
          await fault('ready');
          if (record.target === desired.digest) return readyResult(changed, desired.digest);
          continue;
        }

        if (record?.phase === 'ready') {
          if (observed == null || observed.digest !== record.target) throw new Error('managed operational configuration identity drifted');
          validateObservedConfiguration(observed, validate);
          if (record.target === desired.digest) return readyResult(changed, desired.digest);
        } else if (observed != null) {
          if (observed.digest !== desired.digest) throw new Error('an unmanaged operational configuration already exists');
          validateObservedConfiguration(observed, validate);
          await writeRecord(paths, {
            protocol: RECORD_PROTOCOL,
            phase: 'ready',
            previous: null,
            target: desired.digest,
            content: null,
            staging: null,
            updatedAt: now(),
          });
          return readyResult(false, desired.digest);
        }

        const previous = observed?.digest ?? null;
        await writeRecord(paths, {
          protocol: RECORD_PROTOCOL,
          phase: 'planned',
          previous,
          target: desired.digest,
          content: desired.content,
          staging: `.config-${id()}.tmp`,
          updatedAt: now(),
        });
        await fault('planned');
      }
      throw new Error('operational configuration reconciliation exceeded its bounded transition window');
    },
  });
}
