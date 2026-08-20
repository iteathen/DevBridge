import path from 'node:path';
import { ConfigurationError, PolicyError } from '../errors.js';

const ALLOWED_PLACEHOLDERS = new Set(['projectDir', 'contextFile', 'resultFile', 'runId']);
const SHELL_LIKE = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash', 'sh', 'zsh', 'fish']);
// Environment names are passed structurally to spawn(), never through a shell.
// Parentheses are required for the standard Windows ProgramFiles(x86) name.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_()]*$/;

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

export function validateToolProfile(name, raw, { allowUncontainedTools = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigurationError(`tools.${name} must be an object`);
  if (typeof raw.executable !== 'string' || raw.executable.trim() === '') throw new ConfigurationError(`tools.${name}.executable is required`);

  const basename = path.basename(raw.executable).toLowerCase();
  if (SHELL_LIKE.has(basename) && raw.allowShellLikeExecutable !== true) {
    throw new PolicyError(`tools.${name} uses a shell-like executable; explicit local allowShellLikeExecutable is required`);
  }

  const sandbox = raw.sandbox ?? {};
  const enforcement = sandbox.enforcement ?? 'none';
  if (!['tool', 'os', 'none'].includes(enforcement)) throw new ConfigurationError(`tools.${name}.sandbox.enforcement is invalid`);

  // sandbox.enforcement describes containment the tool/profile itself claims or
  // expects. It is never permission to execute. The outer execution boundary independently
  // requires a verified outer OS provider for every proposal-worker/profile
  // invocation, including profiles that declare "none" here.
  if (sandbox.outsideProjectWrite === true && !allowUncontainedTools) throw new PolicyError(`tools.${name} requests writes outside the project`);

  const outsideProjectRead = sandbox.outsideProjectRead ?? 'deny';
  if (!['deny', 'allowlist', 'readonly'].includes(outsideProjectRead)) throw new ConfigurationError(`tools.${name}.sandbox.outsideProjectRead is invalid`);
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
    environment: { pass: [...pass], set: { ...set } },
    sandbox: {
      enforcement,
      outsideProjectRead,
      outsideProjectWrite: sandbox.outsideProjectWrite === true,
      network
    }
  };
}

export function expandProfileArgs(args, values) {
  return args.map((arg) => arg.replace(/\{(projectDir|contextFile|resultFile|runId)\}/g, (_match, key) => String(values[key])));
}
