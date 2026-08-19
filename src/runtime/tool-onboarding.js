import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { resolveExecutable } from './executable-resolver.js';
import {
  LOCAL_OPERATION_MANIFEST_PROTOCOL,
  createManifestOperationAdapter,
  validateLocalOperationManifest,
} from './local-operation-manifest.js';

const SAFE_COMMAND = /^[A-Za-z0-9_.+-]{1,80}$/u;
const SAFE_OPERATION = /^tool\.[A-Za-z0-9_.-]{1,75}$/u;
const SAFE_HELP_ARG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.=-]{0,79}$/u;
const MAX_HELP_BYTES = 256 * 1024;
const MAX_SYNTHESIZED_ARGUMENTS = 48;
const FORBIDDEN_PARAMETER_NAMES = new Set([
  'command', 'shell', 'argv', 'args', 'executable', 'cwd', 'localpath', 'absolutepath',
  'environment', 'env', 'credentials', 'credential', 'capabilities', 'gitref', 'gitsha',
  'cleanuproot', 'module', 'plugin', 'faultinjection', 'exec', 'eval', 'require', 'chdir',
]);

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedParam(name) {
  const normalized = String(name)
    .replace(/^--?/u, '')
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/-+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,79}$/u.test(normalized)) return null;
  if (FORBIDDEN_PARAMETER_NAMES.has(normalized.replace(/[_-]/gu, ''))) return null;
  return normalized;
}

function valueTypeForMetavar(raw) {
  const value = String(raw ?? '').replace(/[<>\[\]]/gu, '').toUpperCase();
  if (/(?:PATH|FILE|DIR|DIRECTORY|ROOT|DEST|SOURCE)/u.test(value)) return 'project-path';
  if (/(?:NUM|COUNT|JOBS|THREADS|PORT|SIZE|LIMIT|DEPTH)/u.test(value)) return 'integer';
  return 'string';
}

function parseCommands(lines) {
  const commands = [];
  let active = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:commands|subcommands):?$/iu.test(trimmed)) {
      active = true;
      continue;
    }
    if (!active) continue;
    if (trimmed === '') {
      if (commands.length > 0) break;
      continue;
    }
    if (/^[A-Za-z][A-Za-z ]+:$/u.test(trimmed) && !/^[a-z0-9_.-]+\s/iu.test(trimmed)) break;
    const match = line.match(/^\s{1,12}([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?:\s{2,}|\t)/u);
    if (!match) {
      if (commands.length > 0 && !/^\s/u.test(line)) break;
      continue;
    }
    if (!commands.includes(match[1])) commands.push(match[1]);
    if (commands.length >= 32) break;
  }
  return commands;
}

function parseOptions(lines, usedParams) {
  const descriptors = [];
  const seenFlags = new Set();
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('-')) continue;
    const match = trimmed.match(/(?:^|[\s,])(--[A-Za-z0-9][A-Za-z0-9-]{0,79})(?:(?:=|\s+)(<[^>]{1,40}>|\[[A-Za-z][A-Za-z0-9_-]{0,39}\]|[A-Z][A-Z0-9_-]{0,39}(?=$|\s{2,})))?/u);
    if (!match) continue;
    const flag = match[1];
    if (seenFlags.has(flag)) continue;
    const param = normalizedParam(flag);
    if (!param || usedParams.has(param)) continue;
    seenFlags.add(flag);
    usedParams.add(param);
    if (match[2]) {
      descriptors.push({
        kind: 'option',
        param,
        flag,
        required: false,
        repeat: false,
        valueType: valueTypeForMetavar(match[2]),
      });
    } else {
      descriptors.push({ kind: 'flag', param, flag });
    }
    if (descriptors.length >= MAX_SYNTHESIZED_ARGUMENTS) break;
  }
  return descriptors;
}

function usageTokens(lines) {
  const usageLine = lines.find((line) => /^\s*usage\s*:/iu.test(line));
  if (!usageLine) return [];
  const body = usageLine.replace(/^\s*usage\s*:\s*/iu, '');
  const matches = body.match(/<[^>]{1,40}>|\[[A-Za-z][A-Za-z0-9_-]{0,39}(?:\s+\.\.\.)?\](?:\.\.\.)?|\b[A-Z][A-Z0-9_-]{1,39}(?:\.\.\.)?/gu) ?? [];
  return matches.filter((token) => !/^\[?(?:OPTIONS?|FLAGS?)\]?(?:\.\.\.)?$/u.test(token));
}

function parsePositionals(lines, commands, usedParams, remaining) {
  const descriptors = [];
  for (const rawToken of usageTokens(lines)) {
    if (descriptors.length >= remaining) break;
    const optional = rawToken.startsWith('[');
    const repeat = /\.\.\.?\]?$/u.test(rawToken) || /\s+\.\.\.\]$/u.test(rawToken);
    const metavar = rawToken.replace(/[<>\[\]]/gu, '').replace(/\.\.\./gu, '').trim();
    const upper = metavar.toUpperCase();
    if (['OPTION', 'OPTIONS', 'FLAG', 'FLAGS'].includes(upper)) continue;
    if ((upper === 'COMMAND' || upper === 'SUBCOMMAND') && commands.length > 0) {
      const param = 'subcommand';
      if (usedParams.has(param)) continue;
      usedParams.add(param);
      descriptors.push({
        kind: 'positional',
        param,
        required: !optional,
        repeat: false,
        valueType: 'enum',
        values: [...commands].sort(codepointCompare),
      });
      continue;
    }
    const param = normalizedParam(metavar);
    if (!param || usedParams.has(param)) continue;
    usedParams.add(param);
    const descriptor = {
      kind: 'positional',
      param,
      required: !optional,
      repeat,
      valueType: valueTypeForMetavar(metavar),
    };
    if (repeat) descriptor.maxItems = 16;
    descriptors.push(descriptor);
  }
  return descriptors;
}

export function parseCliHelp(helpText) {
  if (typeof helpText !== 'string' || helpText.length === 0 || Buffer.byteLength(helpText, 'utf8') > MAX_HELP_BYTES) {
    throw new PolicyError('CLI help text must be non-empty and bounded');
  }
  const clean = helpText.replace(/\r\n?/gu, '\n').replace(/[\u0000\u001b]/gu, '');
  const lines = clean.split('\n').slice(0, 4096);
  const commands = parseCommands(lines);
  const usedParams = new Set();
  const options = parseOptions(lines, usedParams);
  const positionals = parsePositionals(lines, commands, usedParams, Math.max(0, MAX_SYNTHESIZED_ARGUMENTS - options.length));
  return {
    arguments: [...options, ...positionals],
    commands,
    helpSha256: sha256(clean),
  };
}

function generatedOperation(command, explicit = null) {
  if (explicit != null) {
    if (typeof explicit !== 'string' || !SAFE_OPERATION.test(explicit)) throw new PolicyError('tool onboarding operation is invalid');
    return explicit;
  }
  const suffix = command.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!suffix) throw new PolicyError('tool onboarding command cannot produce a safe operation name');
  return `tool.${suffix}`;
}

function probeEnvironment() {
  const pass = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SystemDrive']
    : ['PATH'];
  return { pass, set: { CI: '1' } };
}

function normalizePolicyEntry(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError(`tool onboarding autoIntegrate[${index}] must be an object`);
  for (const key of Object.keys(raw)) if (!['command', 'operation', 'helpArgs'].includes(key)) throw new PolicyError(`tool onboarding autoIntegrate[${index}].${key} is not allowed`);
  if (typeof raw.command !== 'string' || !SAFE_COMMAND.test(raw.command)) throw new PolicyError(`tool onboarding autoIntegrate[${index}].command is invalid`);
  const helpArgs = raw.helpArgs ?? ['--help'];
  if (!Array.isArray(helpArgs) || helpArgs.length === 0 || helpArgs.length > 4 || helpArgs.some((value) => typeof value !== 'string' || !SAFE_HELP_ARG.test(value))) {
    throw new PolicyError(`tool onboarding autoIntegrate[${index}].helpArgs must contain 1-4 fixed safe option arguments`);
  }
  return {
    command: raw.command,
    operation: generatedOperation(raw.command, raw.operation ?? null),
    helpArgs: [...helpArgs],
  };
}

function sameCanonicalPath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalDirectory(directory, name) {
  const resolved = path.resolve(directory);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new PolicyError(`${name} must be a real directory`);
  const canonical = await realpath(resolved);
  if (!sameCanonicalPath(canonical, resolved)) throw new PolicyError(`${name} must use its canonical path`);
  return canonical;
}

async function readExistingManifest(filePath) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new PolicyError('generated local operation manifest path is not a regular file');
    return validateLocalOperationManifest(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export class ToolOnboardingService {
  #registry;
  #runner;
  #workspaceRoot;
  #manifestDirectory;
  #entries;
  #env;
  #maxHelpBytes;
  #timeoutMs;

  constructor({
    operationRegistry,
    processRunner,
    workspaceRoot,
    manifestDirectory,
    autoIntegrate = [],
    env = process.env,
    maxHelpBytes = MAX_HELP_BYTES,
    timeoutMs = 15_000,
  }) {
    if (!operationRegistry || typeof operationRegistry.register !== 'function') throw new TypeError('ToolOnboardingService requires an operation registry');
    if (!processRunner || typeof processRunner.run !== 'function') throw new TypeError('ToolOnboardingService requires a deterministic process runner');
    this.#registry = operationRegistry;
    this.#runner = processRunner;
    this.#workspaceRoot = path.resolve(workspaceRoot);
    this.#manifestDirectory = path.resolve(manifestDirectory);
    if (pathWithin(this.#workspaceRoot, this.#manifestDirectory)) {
      throw new PolicyError('tool onboarding manifest directory must be outside the controller-writable workspace root');
    }
    this.#entries = autoIntegrate.map(normalizePolicyEntry);
    const operations = new Set();
    for (const entry of this.#entries) {
      if (operations.has(entry.operation)) throw new PolicyError(`tool onboarding duplicates operation ${entry.operation}`);
      operations.add(entry.operation);
    }
    this.#env = env;
    this.#maxHelpBytes = Math.min(MAX_HELP_BYTES, maxHelpBytes);
    this.#timeoutMs = timeoutMs;
  }

  async #registerExisting(entry, manifestPath) {
    const existing = await readExistingManifest(manifestPath);
    if (!existing) return null;
    if (existing.operation !== entry.operation || existing.executable !== entry.command) {
      throw new PolicyError(`generated manifest for ${entry.command} conflicts with local onboarding policy`);
    }
    if (!this.#registry.has(entry.operation)) this.#registry.register(entry.operation, createManifestOperationAdapter(existing, { env: this.#env }));
    return { command: entry.command, operation: entry.operation, state: 'registered-existing', helpSha256: existing.source.helpSha256 ?? null };
  }

  async #probe(entry) {
    let executable;
    try { executable = await resolveExecutable(entry.command, this.#env); }
    catch {
      return { command: entry.command, operation: entry.operation, state: 'unavailable' };
    }
    const probeRoot = await mkdtemp(path.join(this.#workspaceRoot, '.patch-poller-tool-probe-'));
    try {
      const result = await this.#runner.run({
        executable,
        args: entry.helpArgs,
        cwd: probeRoot,
        timeoutMs: this.#timeoutMs,
        maxOutputBytes: this.#maxHelpBytes,
        environment: probeEnvironment(),
        operation: `tool-onboarding.${entry.command}`,
        executionClass: 'repository-code',
        sandbox: {
          required: true,
          projectDir: probeRoot,
          network: 'deny',
          exposeConfiguredReadRoots: false,
        },
      });
      if (result.timedOut) return { command: entry.command, operation: entry.operation, state: 'probe-timeout' };
      if (result.outputTruncated) return { command: entry.command, operation: entry.operation, state: 'probe-output-truncated' };
      const help = [result.stdout, result.stderr].filter(Boolean).join('\n');
      if (!help.trim()) return { command: entry.command, operation: entry.operation, state: 'probe-no-documentation', exitCode: result.exitCode };
      const parsed = parseCliHelp(help);
      if (parsed.arguments.length === 0) return { command: entry.command, operation: entry.operation, state: 'probe-no-safe-interface', exitCode: result.exitCode };
      const manifest = validateLocalOperationManifest({
        protocol: LOCAL_OPERATION_MANIFEST_PROTOCOL,
        operation: entry.operation,
        executable: entry.command,
        arguments: parsed.arguments,
        timeoutMs: 120_000,
        maxOutputBytes: 1024 * 1024,
        requireAnyParameter: true,
        source: { kind: 'help-synthesized', command: entry.command, helpSha256: parsed.helpSha256 },
      });
      return { command: entry.command, operation: entry.operation, state: 'synthesized', manifest, helpSha256: parsed.helpSha256, exitCode: result.exitCode };
    } catch (error) {
      return {
        command: entry.command,
        operation: entry.operation,
        state: 'probe-blocked',
        errorClass: error?.name ?? 'Error',
      };
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  }

  async reconcile() {
    if (this.#entries.length === 0) return { changed: false, events: [] };
    const manifestRoot = await canonicalDirectory(this.#manifestDirectory, 'tool onboarding manifest directory');
    const events = [];
    let changed = false;
    for (const entry of this.#entries) {
      const fileName = `auto-${entry.operation.replace(/[^A-Za-z0-9_.-]/gu, '-')}.json`;
      const manifestPath = path.join(manifestRoot, fileName);
      const existing = await this.#registerExisting(entry, manifestPath);
      if (existing) {
        events.push(existing);
        continue;
      }
      if (this.#registry.has(entry.operation)) {
        events.push({ command: entry.command, operation: entry.operation, state: 'registered' });
        continue;
      }
      const observation = await this.#probe(entry);
      if (observation.state !== 'synthesized') {
        events.push(observation);
        continue;
      }
      const content = `${JSON.stringify(observation.manifest, null, 2)}\n`;
      try {
        await writeFile(manifestPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const reconciled = await this.#registerExisting(entry, manifestPath);
        if (!reconciled) throw new PolicyError(`tool onboarding could not reconcile generated manifest for ${entry.command}`);
        events.push(reconciled);
        continue;
      }
      this.#registry.register(entry.operation, createManifestOperationAdapter(observation.manifest, { env: this.#env }));
      changed = true;
      events.push({
        command: entry.command,
        operation: entry.operation,
        state: 'registered-synthesized',
        helpSha256: observation.helpSha256,
        parameterCount: observation.manifest.arguments.filter((arg) => arg.param).length,
      });
    }
    return { changed, events };
  }
}

export function validateToolOnboardingPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new PolicyError('tool onboarding policy must be an object');
  const entries = policy.autoIntegrate ?? [];
  if (!Array.isArray(entries) || entries.length > 32) throw new PolicyError('tool onboarding autoIntegrate must contain at most 32 entries');
  const normalized = entries.map(normalizePolicyEntry);
  const commands = new Set();
  for (const entry of normalized) {
    if (commands.has(entry.command)) throw new PolicyError(`tool onboarding duplicates command ${entry.command}`);
    commands.add(entry.command);
  }
  return normalized;
}
