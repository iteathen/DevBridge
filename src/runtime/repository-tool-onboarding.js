import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import {
  LOCAL_OPERATION_MANIFEST_PROTOCOL,
  createManifestOperationAdapter,
  validateLocalOperationManifest,
} from './local-operation-manifest.js';
import {
  REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
  normalizeRepositoryExecutionResult,
} from './repository-execution.js';
import { parseCliHelp } from './tool-onboarding.js';

const SAFE_COMMAND = /^[A-Za-z0-9_.+-]{1,80}$/u;
const SAFE_OPERATION = /^tool\.[A-Za-z0-9_.-]{1,75}$/u;
const SAFE_HELP_ARG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.=-]{0,79}$/u;

function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError(`repository tool entry[${index}] must be an object`);
  if (typeof raw.command !== 'string' || !SAFE_COMMAND.test(raw.command)) throw new PolicyError(`repository tool entry[${index}].command is invalid`);
  if (typeof raw.operation !== 'string' || !SAFE_OPERATION.test(raw.operation)) throw new PolicyError(`repository tool entry[${index}].operation is invalid`);
  const helpArgs = raw.helpArgs ?? ['--help'];
  if (!Array.isArray(helpArgs) || helpArgs.length === 0 || helpArgs.length > 4 || helpArgs.some((value) => typeof value !== 'string' || !SAFE_HELP_ARG.test(value))) {
    throw new PolicyError(`repository tool entry[${index}].helpArgs are invalid`);
  }
  return { command: raw.command, operation: raw.operation, helpArgs: [...helpArgs] };
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new PolicyError('repository tool probing requires an exact execution scope');
  return { repository: scope.repository, repositoryId: scope.repositoryId ?? null, runId: scope.runId };
}

async function readManifest(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new PolicyError('repository tool manifest path is invalid');
    return validateLocalOperationManifest(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function persistManifest(file, manifest) {
  const normalized = validateLocalOperationManifest(manifest);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  return normalized;
}

export class RepositoryToolOnboarding {
  #registry;
  #execution;
  #directory;
  #entries;
  #probeTimeoutMs;
  #maxHelpBytes;

  constructor({ operationRegistry, repositoryExecution, manifestDirectory, entries = [], probeTimeoutMs = 15_000, maxHelpBytes = 256 * 1024 }) {
    if (!operationRegistry || typeof operationRegistry.register !== 'function' || typeof operationRegistry.has !== 'function') throw new TypeError('repository tool onboarding registry contract is incomplete');
    if (!repositoryExecution || typeof repositoryExecution.inspect !== 'function' || typeof repositoryExecution.execute !== 'function') throw new TypeError('repository tool onboarding execution contract is incomplete');
    if (typeof manifestDirectory !== 'string' || manifestDirectory.length === 0 || !path.isAbsolute(manifestDirectory)) throw new TypeError('repository tool onboarding manifestDirectory must be absolute');
    if (!Array.isArray(entries) || entries.length > 32) throw new TypeError('repository tool onboarding entries are invalid');
    if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1_000 || probeTimeoutMs > 60_000) throw new TypeError('repository tool onboarding probeTimeoutMs is invalid');
    if (!Number.isSafeInteger(maxHelpBytes) || maxHelpBytes < 4_096 || maxHelpBytes > 256 * 1024) throw new TypeError('repository tool onboarding maxHelpBytes is invalid');
    this.#registry = operationRegistry;
    this.#execution = repositoryExecution;
    this.#directory = path.resolve(manifestDirectory);
    this.#entries = entries.map(normalizeEntry);
    this.#probeTimeoutMs = probeTimeoutMs;
    this.#maxHelpBytes = maxHelpBytes;
  }

  async #existing(entry) {
    const file = path.join(this.#directory, `auto-${entry.operation.replace(/[^A-Za-z0-9_.-]/gu, '-')}.json`);
    const manifest = await readManifest(file);
    if (!manifest) return { file, manifest: null };
    if (manifest.operation !== entry.operation || manifest.executable !== entry.command) throw new PolicyError(`repository tool manifest conflicts with local policy for ${entry.command}`);
    if (!this.#registry.has(entry.operation)) this.#registry.register(entry.operation, createManifestOperationAdapter(manifest));
    return { file, manifest };
  }

  async reconcile(scope = null) {
    const events = [];
    let changed = false;
    const status = this.#execution.inspect();
    for (const entry of this.#entries) {
      const existing = await this.#existing(entry);
      if (existing.manifest) {
        events.push({ command: entry.command, operation: entry.operation, state: 'registered-existing', helpSha256: existing.manifest.source.helpSha256 ?? null });
        continue;
      }
      if (this.#registry.has(entry.operation)) {
        events.push({ command: entry.command, operation: entry.operation, state: 'registered' });
        continue;
      }
      if (status.ready !== true) {
        events.push({ command: entry.command, operation: entry.operation, state: 'repository-execution-unavailable', reason: status.reason ?? 'repository execution is not ready' });
        continue;
      }
      if (scope == null) {
        events.push({ command: entry.command, operation: entry.operation, state: 'repository-scope-required', reason: 'repository tool probing requires an exact execution scope' });
        continue;
      }
      const result = normalizeRepositoryExecutionResult(await this.#execution.execute({
        protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
        operation: `tool.probe:${entry.operation}`,
        scope: normalizeScope(scope),
        invocation: { tool: entry.command, arguments: entry.helpArgs, workingDirectory: '.' },
        environment: { CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', DEVBRIDGE_NONINTERACTIVE: '1' },
        transfers: [],
        limits: { timeoutMs: this.#probeTimeoutMs, maxOutputBytes: this.#maxHelpBytes },
        stdin: null,
        signal: null,
        onActivity: null,
      }));
      if (result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) {
        const reason = String(result.stderr || result.stdout || 'repository tool probe failed').trim().slice(0, 2_048);
        events.push({ command: entry.command, operation: entry.operation, state: 'probe-failed', reason });
        continue;
      }
      const help = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const parsed = parseCliHelp(help);
      const manifest = await persistManifest(existing.file, {
        protocol: LOCAL_OPERATION_MANIFEST_PROTOCOL,
        operation: entry.operation,
        executable: entry.command,
        arguments: parsed.arguments,
        timeoutMs: 120_000,
        maxOutputBytes: 1024 * 1024,
        requireAnyParameter: parsed.arguments.some((argument) => argument.param),
        source: { kind: 'help-synthesized', command: entry.command, helpSha256: parsed.helpSha256 },
      });
      this.#registry.register(entry.operation, createManifestOperationAdapter(manifest));
      changed = true;
      events.push({ command: entry.command, operation: entry.operation, state: 'registered-probed', helpSha256: parsed.helpSha256 });
    }
    return { changed, events };
  }
}
