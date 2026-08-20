import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import {
  LOCAL_OPERATION_MANIFEST_PROTOCOL,
  createManifestOperationAdapter,
  validateLocalOperationManifest,
} from './local-operation-manifest.js';
import { parseCliHelp } from './cli-help-parser.js';

const SAFE_COMMAND = /^[A-Za-z0-9_.+-]{1,80}$/u;
const SAFE_OPERATION = /^tool\.[A-Za-z0-9_.-]{1,75}$/u;
const SAFE_HELP_ARG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.=-]{0,79}$/u;

function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyError(`tool onboarding entry[${index}] must be an object`);
  }
  if (typeof raw.command !== 'string' || !SAFE_COMMAND.test(raw.command)) {
    throw new PolicyError(`tool onboarding entry[${index}].command is invalid`);
  }
  if (typeof raw.operation !== 'string' || !SAFE_OPERATION.test(raw.operation)) {
    throw new PolicyError(`tool onboarding entry[${index}].operation is invalid`);
  }
  const helpArgs = raw.helpArgs ?? ['--help'];
  if (!Array.isArray(helpArgs) || helpArgs.length === 0 || helpArgs.length > 4 ||
      helpArgs.some((value) => typeof value !== 'string' || !SAFE_HELP_ARG.test(value))) {
    throw new PolicyError(`tool onboarding entry[${index}].helpArgs are invalid`);
  }
  return Object.freeze({ command: raw.command, operation: raw.operation, helpArgs: Object.freeze([...helpArgs]) });
}

function normalizeAvailability(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.ready !== 'boolean') {
    throw new TypeError('tool onboarding probe availability is invalid');
  }
  return { ready: raw.ready, reason: raw.reason == null ? null : String(raw.reason).slice(0, 2_048) };
}

function normalizeProbeResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('tool onboarding probe result is invalid');
  if (!Number.isSafeInteger(raw.exitCode) && raw.exitCode !== null) throw new TypeError('tool onboarding probe exitCode is invalid');
  for (const name of ['timedOut', 'aborted', 'outputTruncated']) {
    if (typeof raw[name] !== 'boolean') throw new TypeError(`tool onboarding probe ${name} is invalid`);
  }
  if (typeof raw.stdout !== 'string' || typeof raw.stderr !== 'string') {
    throw new TypeError('tool onboarding probe output is invalid');
  }
  return raw;
}

async function readManifest(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
      throw new PolicyError('tool onboarding manifest path is invalid');
    }
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

export class ToolOnboarding {
  #registry;
  #probe;
  #directory;
  #entries;
  #probeTimeoutMs;
  #maxHelpBytes;

  constructor({ operationRegistry, probe, manifestDirectory, entries = [], probeTimeoutMs = 15_000, maxHelpBytes = 256 * 1024 }) {
    if (!operationRegistry || typeof operationRegistry.register !== 'function' || typeof operationRegistry.has !== 'function') {
      throw new TypeError('tool onboarding registry contract is incomplete');
    }
    if (!probe || typeof probe.inspect !== 'function' || typeof probe.run !== 'function') {
      throw new TypeError('tool onboarding probe contract is incomplete');
    }
    if (typeof manifestDirectory !== 'string' || manifestDirectory.length === 0 || !path.isAbsolute(manifestDirectory)) {
      throw new TypeError('tool onboarding manifestDirectory must be absolute');
    }
    if (!Array.isArray(entries) || entries.length > 32) throw new TypeError('tool onboarding entries are invalid');
    if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1_000 || probeTimeoutMs > 60_000) {
      throw new TypeError('tool onboarding probeTimeoutMs is invalid');
    }
    if (!Number.isSafeInteger(maxHelpBytes) || maxHelpBytes < 4_096 || maxHelpBytes > 256 * 1024) {
      throw new TypeError('tool onboarding maxHelpBytes is invalid');
    }
    this.#registry = operationRegistry;
    this.#probe = probe;
    this.#directory = path.resolve(manifestDirectory);
    this.#entries = entries.map(normalizeEntry);
    const commands = new Set();
    const operations = new Set();
    for (const entry of this.#entries) {
      if (commands.has(entry.command)) throw new PolicyError(`tool onboarding duplicates command ${entry.command}`);
      if (operations.has(entry.operation)) throw new PolicyError(`tool onboarding duplicates operation ${entry.operation}`);
      commands.add(entry.command);
      operations.add(entry.operation);
    }
    this.#probeTimeoutMs = probeTimeoutMs;
    this.#maxHelpBytes = maxHelpBytes;
  }

  async #existing(entry) {
    const file = path.join(this.#directory, `auto-${entry.operation.replace(/[^A-Za-z0-9_.-]/gu, '-')}.json`);
    const manifest = await readManifest(file);
    if (!manifest) return { file, manifest: null };
    if (manifest.operation !== entry.operation || manifest.executable !== entry.command) {
      throw new PolicyError(`tool onboarding manifest conflicts with local policy for ${entry.command}`);
    }
    if (!this.#registry.has(entry.operation)) {
      this.#registry.register(entry.operation, createManifestOperationAdapter(manifest));
    }
    return { file, manifest };
  }

  async reconcile(context = null) {
    if (this.#entries.length === 0) return { changed: false, events: [] };
    const events = [];
    let changed = false;
    const availability = normalizeAvailability(this.#probe.inspect());
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
      if (!availability.ready) {
        events.push({ command: entry.command, operation: entry.operation, state: 'probe-unavailable', reason: availability.reason ?? 'probe is not ready' });
        continue;
      }
      if (context == null) {
        events.push({ command: entry.command, operation: entry.operation, state: 'probe-context-required', reason: 'tool probing requires an exact execution context' });
        continue;
      }
      const result = normalizeProbeResult(await this.#probe.run({
        name: entry.operation,
        command: entry.command,
        arguments: [...entry.helpArgs],
        context,
        environment: { CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', DEVBRIDGE_NONINTERACTIVE: '1' },
        limits: { timeoutMs: this.#probeTimeoutMs, maxOutputBytes: this.#maxHelpBytes },
      }));
      if (result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) {
        const reason = String(result.stderr || result.stdout || 'tool probe failed').trim().slice(0, 2_048);
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
