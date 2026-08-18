import path from 'node:path';
import { ConfigurationError, PolicyError } from '../errors.js';

const ALLOWED_PLACEHOLDERS = new Set(['projectDir', 'contextFile', 'resultFile', 'runId']);
const SHELL_LIKE = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash', 'sh', 'zsh', 'fish']);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_()]*$/;
const CONTROL_OWNED_PROFILE_NAMES = new Set([
  'patch-poller-native-compiler',
  'patch-poller-transient-recovery',
  'patch-poller-chat-c-project',
  'patch-poller-lifecycle-roundtrip',
]);

function validateArgs(args, name) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new ConfigurationError(`tools.${name}.args must be an array of strings`);
  }
  for (const arg of args) {
    for (const match of arg.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
      if (!ALLOWED_PLACEHOLDERS.has(match[1])) {
        throw new ConfigurationError(`tools.${name}.args uses unsupported placeholder {${match[1]}}`);
      }
    }
  }
  return [...args];
}

function validateReadOnlyRoots(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new ConfigurationError(`tools.${name}.sandbox.readOnlyRoots must contain at most 32 absolute local paths`);
  }
  const roots = value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '' || !path.isAbsolute(entry)) {
      throw new ConfigurationError(`tools.${name}.sandbox.readOnlyRoots[${index}] must be an absolute local path`);
    }
    return path.normalize(entry);
  });
  return [...new Set(roots)];
}

export function validateToolProfile(name, raw, { allowUncontainedTools = false, allowControlOwnedTools = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigurationError(`tools.${name} must be an object`);
  if (typeof raw.executable !== 'string' || raw.executable.trim() === '') throw new ConfigurationError(`tools.${name}.executable is required`);

  const controlOwned = raw.controlOwned === true;
  const reservedControlProfile = CONTROL_OWNED_PROFILE_NAMES.has(name);
  if (controlOwned && !allowControlOwnedTools && !reservedControlProfile) {
    throw new PolicyError(`tools.${name}.controlOwned is reserved for PATCH-POLLER built-in profiles`);
  }
  if (reservedControlProfile && !controlOwned) {
    throw new PolicyError(`reserved PATCH-POLLER profile ${name} must remain control-owned`);
  }

  const basename = path.basename(raw.executable).toLowerCase();
  if (SHELL_LIKE.has(basename) && raw.allowShellLikeExecutable !== true) {
    throw new PolicyError(`tools.${name} uses a shell-like executable; explicit local allowShellLikeExecutable is required`);
  }

  const sandbox = raw.sandbox ?? {};
  const enforcement = sandbox.enforcement ?? 'none';
  if (!['tool', 'os', 'none'].includes(enforcement)) throw new ConfigurationError(`tools.${name}.sandbox.enforcement is invalid`);
  if (enforcement === 'none' && !allowUncontainedTools && !controlOwned) throw new PolicyError(`tools.${name} has no declared containment enforcement`);
  if (sandbox.outsideProjectWrite === true && !allowUncontainedTools && !controlOwned) throw new PolicyError(`tools.${name} permits writes outside the project`);

  const outsideProjectRead = sandbox.outsideProjectRead ?? 'deny';
  if (!['deny', 'allowlist', 'readonly'].includes(outsideProjectRead)) throw new ConfigurationError(`tools.${name}.sandbox.outsideProjectRead is invalid`);
  const readOnlyRoots = validateReadOnlyRoots(sandbox.readOnlyRoots, name);
  if (readOnlyRoots.length > 0 && outsideProjectRead !== 'allowlist' && !controlOwned) {
    throw new PolicyError(`tools.${name}.sandbox.readOnlyRoots requires outsideProjectRead=allowlist`);
  }
  const network = sandbox.network ?? 'deny';
  if (!['deny', 'restricted', 'unrestricted'].includes(network)) throw new ConfigurationError(`tools.${name}.sandbox.network is invalid`);

  const inputMode = raw.inputMode ?? 'stdin-json';
  if (!['stdin-json', 'stdin-text', 'context-file', 'none'].includes(inputMode)) throw new ConfigurationError(`tools.${name}.inputMode is invalid`);

  const environment = raw.environment ?? {};
  const pass = environment.pass ?? [];
  if (!Array.isArray(pass) || pass.some((entry) => typeof entry !== 'string' || !ENV_NAME_RE.test(entry))) {
    throw new ConfigurationError(`tools.${name}.environment.pass must contain environment variable names`);
  }
  const set = environment.set ?? {};
  if (!set || typeof set !== 'object' || Array.isArray(set) || Object.entries(set).some(([key, value]) => !ENV_NAME_RE.test(key) || typeof value !== 'string')) {
    throw new ConfigurationError(`tools.${name}.environment.set must be a string map`);
  }

  const timeoutMs = raw.timeoutMs ?? 2_700_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 28_800_000) throw new ConfigurationError(`tools.${name}.timeoutMs is out of range`);
  const maxOutputBytes = raw.maxOutputBytes ?? 4_194_304;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16_777_216) throw new ConfigurationError(`tools.${name}.maxOutputBytes is out of range`);

  return {
    name,
    executable: raw.executable,
    args: validateArgs(raw.args ?? [], name),
    inputMode,
    timeoutMs,
    maxOutputBytes,
    controlOwned,
    environment: { pass: [...pass], set: { ...set } },
    sandbox: {
      enforcement,
      outsideProjectRead,
      readOnlyRoots,
      outsideProjectWrite: sandbox.outsideProjectWrite === true,
      network
    }
  };
}

export function expandProfileArgs(args, values) {
  return args.map((arg) => arg.replace(/\{(projectDir|contextFile|resultFile|runId)\}/g, (_match, key) => String(values[key])));
}
