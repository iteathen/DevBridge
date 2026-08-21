import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  REPOSITORY_EXECUTION_RESULT_PROTOCOL,
  REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  normalizeRepositoryExecutionRequest,
  normalizeRepositoryScratchCleanup,
} from '../runtime/repository-execution.js';
import { DeterministicProcessRunner } from '../runtime/deterministic-process-runner.js';

const TRANSFER_LIMIT = 16 * 1024 * 1024;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function resourcePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) throw new Error('fast tool resource path is invalid');
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('/') || normalized.startsWith('../')) throw new Error('fast tool resource path escapes its session');
  return normalized;
}

async function readTransfer(port) {
  const first = await port.read({ offset: 0, limit: TRANSFER_LIMIT });
  if (Buffer.isBuffer(first) || typeof first === 'string' || ArrayBuffer.isView(first)) return Buffer.from(first);
  if (!first || typeof first !== 'object') throw new Error('fast input transfer returned an invalid value');
  const chunks = [Buffer.from(first.data ?? [])];
  let offset = chunks[0].length;
  let frame = first;
  while (frame.eof !== true) {
    if (offset >= TRANSFER_LIMIT) throw new Error('fast input transfer exceeded its limit');
    frame = await port.read({ offset, limit: TRANSFER_LIMIT - offset });
    if (!frame || typeof frame !== 'object') throw new Error('fast input transfer returned an invalid frame');
    const data = Buffer.from(frame.data ?? []);
    if (data.length === 0 && frame.eof !== true) throw new Error('fast input transfer made no progress');
    chunks.push(data);
    offset += data.length;
  }
  if (offset > TRANSFER_LIMIT) throw new Error('fast input transfer exceeded its limit');
  return Buffer.concat(chunks);
}

async function stageResources(directory, resolved) {
  const resources = resolved.resources ?? [];
  if (!Array.isArray(resources)) throw new Error('fast tool resources are invalid');
  for (const resource of resources) {
    const relative = resourcePath(resource?.path);
    const destination = path.join(directory, ...relative.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(resource.bytes));
  }
  if (resolved.entry == null) return null;
  const entry = resourcePath(resolved.entry);
  const location = path.join(directory, ...entry.split('/'));
  const info = await lstat(location);
  if (!info.isFile()) throw new Error('fast tool entry is not a file');
  return location;
}

export function createFastHostRepositoryExecution({
  stateDirectory,
  rootFor,
  resolveTool,
  sourceEnv = process.env,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('fast execution stateDirectory is required');
  if (typeof rootFor !== 'function' || typeof resolveTool !== 'function') throw new TypeError('fast execution composition is incomplete');
  const sessionsRoot = path.join(path.resolve(stateDirectory), 'fast-host-execution');
  const scratchRoot = path.join(sessionsRoot, 'scratch');
  const runner = new DeterministicProcessRunner({ sourceEnv, processPriority: 'below-normal' });
  const status = Object.freeze({
    protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
    state: 'ready',
    ready: true,
    identity: 'fast-host-direct-v1',
    reason: null,
  });

  return Object.freeze({
    inspect() { return status; },
    async cleanupScratch(rawRequest) {
      const request = normalizeRepositoryScratchCleanup(rawRequest);
      await mkdir(scratchRoot, { recursive: true });
      const scratchRootInfo = await lstat(scratchRoot);
      if (!scratchRootInfo.isDirectory() || scratchRootInfo.isSymbolicLink()) throw new Error('fast execution scratch root is unsafe');
      const runRoot = path.resolve(scratchRoot, request.scope.runId);
      if (!isWithin(scratchRoot, runRoot)) throw new Error('fast execution scratch run escapes its root');
      for (const name of request.names) {
        const target = path.resolve(runRoot, name);
        if (!isWithin(runRoot, target)) throw new Error('fast execution scratch target escapes its run');
        try {
          const info = await lstat(target);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('fast execution scratch target is unsafe');
          await rm(target, { recursive: true, force: false });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        try { await lstat(target); throw new Error('fast execution scratch cleanup was not verified'); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
      return { verifiedAbsent: true, names: structuredClone(request.names) };
    },
    async execute(rawRequest) {
      const request = normalizeRepositoryExecutionRequest(rawRequest);
      const root = await realpath(path.resolve(await rootFor(structuredClone(request.scope))));
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory()) throw new Error('fast execution root is not a directory');
      const working = await realpath(path.resolve(root, ...request.invocation.workingDirectory.replace(/\\/gu, '/').split('/')));
      if (!isWithin(root, working)) throw new Error('fast execution working directory escapes its root');

      await mkdir(sessionsRoot, { recursive: true });
      const session = path.join(sessionsRoot, `${request.scope.runId}-${randomUUID()}`);
      await mkdir(session, { recursive: false });
      try {
        const transferFiles = new Map();
        for (const transfer of request.transfers) {
          const location = path.join(session, `port-${transfer.name}`);
          transferFiles.set(transfer.name, location);
          if (transfer.direction === 'input') await writeFile(location, await readTransfer(transfer.port));
          else await writeFile(location, Buffer.alloc(0));
        }

        const resolved = await resolveTool(request.invocation.tool, {
          scope: structuredClone(request.scope),
          operation: request.operation,
        });
        if (!resolved || typeof resolved.program !== 'string' || resolved.program.length === 0) throw new Error('fast execution tool did not resolve to a program');
        if (!Array.isArray(resolved.arguments) || resolved.arguments.some((value) => typeof value !== 'string')) throw new Error('fast execution tool arguments are invalid');
        const entry = await stageResources(session, resolved);
        const invocationArgs = [];
        for (const argument of request.invocation.arguments) {
          if (argument.kind === 'literal') { invocationArgs.push(argument.value); continue; }
          if (argument.kind === 'scratch') {
            const location = path.resolve(scratchRoot, request.scope.runId, argument.name);
            if (!isWithin(scratchRoot, location)) throw new Error('fast execution scratch argument escapes its root');
            await mkdir(location, { recursive: true });
            const info = await lstat(location);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('fast execution scratch argument is unsafe');
            invocationArgs.push(location);
            continue;
          }
          invocationArgs.push(transferFiles.get(argument.name));
        }
        const args = [
          ...(entry ? [entry] : []),
          ...resolved.arguments,
          ...invocationArgs,
        ];

        const observed = await runner.run({
          executable: resolved.program,
          args,
          cwd: working,
          timeoutMs: request.limits.timeoutMs,
          maxOutputBytes: request.limits.maxOutputBytes,
          environment: { pass: Object.keys(sourceEnv), set: request.environment },
          stdin: request.stdin,
          signal: request.signal,
          onActivity: request.onActivity,
          operation: request.operation,
          executionClass: 'control-process',
        });

        for (const transfer of request.transfers.filter((entry) => entry.direction === 'output')) {
          const bytes = await readFile(transferFiles.get(transfer.name));
          if (bytes.length > TRANSFER_LIMIT) throw new Error('fast output transfer exceeded its limit');
          await transfer.port.write(bytes);
        }

        const evidenceIdentity = `fast-${createHash('sha256').update(`${root}\0${request.scope.runId}`).digest('hex').slice(0, 32)}`;
        return {
          protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
          exitCode: observed.exitCode,
          signal: observed.signal,
          timedOut: observed.timedOut,
          aborted: observed.aborted,
          outputTruncated: observed.outputTruncated,
          stdout: observed.stdout,
          stderr: observed.stderr,
          startedAt: observed.startedAt,
          finishedAt: observed.finishedAt,
          lastOutputAt: observed.lastOutputAt,
          evidence: { identity: evidenceIdentity, scope: structuredClone(request.scope) },
        };
      } finally {
        await rm(session, { recursive: true, force: true });
      }
    },
  });
}
