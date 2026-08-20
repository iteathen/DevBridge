import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import {
  LOCAL_OPERATION_MANIFEST_PROTOCOL,
  createManifestOperationAdapter,
  validateLocalOperationManifest,
} from '../runtime/local-operation-manifest.js';
import {
  REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
  assertRepositoryExecutionContract,
  normalizeRepositoryExecutionResult,
} from '../runtime/repository-execution.js';

async function readManifest(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new PolicyError('generated operation manifest path is invalid');
    return validateLocalOperationManifest(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function persistManifest(file, value) {
  const manifest = validateLocalOperationManifest(value);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  return manifest;
}

function fileFor(directory, operation) {
  return path.join(directory, `auto-${operation.replace(/[^A-Za-z0-9_.-]/gu, '-')}.json`);
}

export function createOnboardingRecordPort({ directory, operationRegistry }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('record directory must be absolute');
  if (!operationRegistry || typeof operationRegistry.has !== 'function' || typeof operationRegistry.register !== 'function') throw new TypeError('operation registry contract is incomplete');
  return {
    async restore(entry) {
      const manifest = await readManifest(fileFor(directory, entry.operation));
      if (!manifest) return null;
      if (manifest.operation !== entry.operation || manifest.executable !== entry.command) throw new PolicyError(`generated manifest for ${entry.command} conflicts with local policy`);
      if (!operationRegistry.has(entry.operation)) operationRegistry.register(entry.operation, createManifestOperationAdapter(manifest));
      return { helpSha256: manifest.source.helpSha256 ?? null };
    },
    has(operation) { return operationRegistry.has(operation); },
    async publish({ entry, parsed }) {
      const manifest = await persistManifest(fileFor(directory, entry.operation), {
        protocol: LOCAL_OPERATION_MANIFEST_PROTOCOL,
        operation: entry.operation,
        executable: entry.command,
        arguments: parsed.arguments,
        timeoutMs: 120_000,
        maxOutputBytes: 1024 * 1024,
        requireAnyParameter: parsed.arguments.some((argument) => argument.param),
        source: { kind: 'help-synthesized', command: entry.command, helpSha256: parsed.helpSha256 },
      });
      operationRegistry.register(entry.operation, createManifestOperationAdapter(manifest));
    },
  };
}

export function createOnboardingProbePort(activeExecution) {
  const execution = assertRepositoryExecutionContract(activeExecution);
  return {
    inspect() {
      const status = execution.inspect();
      return { ready: status.ready, reason: status.reason };
    },
    async run(request) {
      const scope = request.context?.scope ?? request.context;
      return normalizeRepositoryExecutionResult(await execution.execute({
        protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
        operation: `onboarding:${request.name}`,
        scope,
        invocation: { tool: request.command, arguments: request.arguments, workingDirectory: '.' },
        environment: request.environment,
        transfers: [],
        limits: request.limits,
        stdin: null,
      }));
    },
  };
}

export function connectToolOnboarding({ onboarding, directory, operationRegistry, activeExecution }) {
  if (!onboarding || typeof onboarding.reconcile !== 'function') throw new TypeError('onboarding contract is incomplete');
  return Object.freeze({
    reconcile(context = null) {
      return onboarding.reconcile({
        context,
        probe: createOnboardingProbePort(activeExecution),
        records: createOnboardingRecordPort({ directory, operationRegistry }),
      });
    },
  });
}
