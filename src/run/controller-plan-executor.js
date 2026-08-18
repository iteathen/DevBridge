import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { isWithin } from '../security/workspace-policy.js';

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileDigest(filePath) {
  return sha256Bytes(await readFile(filePath));
}

async function assertContainedNoFollow(root, relative, { allowMissing = true } = {}) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relative);
  if (!isWithin(rootResolved, target)) throw new PolicyError(`controller path escaped worktree: ${relative}`);
  const rootReal = await realpath(rootResolved);
  let cursor = target;
  while (!(await exists(cursor))) {
    if (!allowMissing) throw new PolicyError(`controller path does not exist: ${relative}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new PolicyError(`controller path has no contained ancestor: ${relative}`);
    cursor = parent;
  }
  const info = await lstat(cursor);
  if (info.isSymbolicLink()) throw new PolicyError(`controller path crosses a symbolic link/junction: ${relative}`);
  const ancestorReal = await realpath(cursor);
  if (!isWithin(rootReal, ancestorReal)) throw new PolicyError(`controller path escapes through filesystem indirection: ${relative}`);
  if (await exists(target)) {
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink()) throw new PolicyError(`controller path targets a symbolic link/junction: ${relative}`);
    const targetReal = await realpath(target);
    if (!isWithin(rootReal, targetReal)) throw new PolicyError(`controller path resolves outside worktree: ${relative}`);
  }
  return target;
}

async function atomicWrite(target, content, root) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await assertContainedNoFollow(root, path.relative(root, path.dirname(target)) || '.');
  const temp = `${target}.patch-poller-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temp, target);
}

function operationResultEvidence(id, operation, result) {
  return {
    id,
    operation,
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    outputTruncated: result.outputTruncated === true,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    startedAt: result.startedAt ?? null,
    finishedAt: result.finishedAt ?? null,
    lastOutputAt: result.lastOutputAt ?? null
  };
}

function primitiveAtPath(value, dotted) {
  let current = value;
  for (const segment of dotted.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment)) return { found: false, value: undefined };
    current = current[segment];
  }
  return { found: true, value: current };
}

export class ControllerPlanExecutor {
  #registry;
  #processRunner;
  #workspace;

  constructor({ operationRegistry, processRunner, workspaceManager }) {
    this.#registry = operationRegistry;
    this.#processRunner = processRunner;
    this.#workspace = workspaceManager;
  }

  async #applyFile(file, context) {
    const target = await assertContainedNoFollow(context.workspace.worktreeDir, file.path);
    const present = await exists(target);
    const currentDigest = present ? await fileDigest(target) : null;

    if (file.scope === 'ephemeral') {
      if (file.action === 'reserve') return { path: file.path, action: 'reserve', digest: currentDigest };
      if (present && currentDigest !== file.contentSha256) throw new PolicyError(`ephemeral create would overwrite existing path ${file.path}`);
      if (!present) await atomicWrite(target, file.content, context.workspace.worktreeDir);
      return { path: file.path, action: 'create', digest: file.contentSha256 };
    }

    if (file.action === 'create') {
      if (present && currentDigest !== file.contentSha256) throw new PolicyError(`controller create target already exists with different content: ${file.path}`);
      if (!present) await atomicWrite(target, file.content, context.workspace.worktreeDir);
      return { path: file.path, action: 'create', digest: file.contentSha256 };
    }
    if (file.action === 'replace') {
      if (!present) throw new PolicyError(`controller replace target does not exist: ${file.path}`);
      if (currentDigest === file.contentSha256) return { path: file.path, action: 'replace', digest: file.contentSha256, reconciled: true };
      if (currentDigest !== file.expectedSha256) throw new PolicyError(`controller replace stale digest for ${file.path}`);
      await atomicWrite(target, file.content, context.workspace.worktreeDir);
      return { path: file.path, action: 'replace', digest: file.contentSha256 };
    }
    if (file.action === 'delete') {
      if (!present) return { path: file.path, action: 'delete', digest: null, reconciled: true };
      if (currentDigest !== file.expectedSha256) throw new PolicyError(`controller delete stale digest for ${file.path}`);
      const info = await stat(target);
      if (!info.isFile()) throw new PolicyError(`controller delete only supports regular files: ${file.path}`);
      await rm(target, { force: false });
      return { path: file.path, action: 'delete', digest: null };
    }
    throw new PolicyError(`unsupported controller file action ${file.action}`);
  }

  async #cleanup(state, workspace, persist) {
    const ledger = state.controllerPlan?.cleanupLedger ?? [];
    for (const entry of ledger) {
      if (entry.state === 'verified-absent') continue;
      const target = await assertContainedNoFollow(workspace.worktreeDir, entry.path);
      entry.state = 'cleanup-planned';
      entry.updatedAt = new Date().toISOString();
      await persist();
      if (await exists(target)) {
        const info = await lstat(target);
        if (info.isDirectory()) throw new PolicyError(`cleanup ledger entry unexpectedly became a directory: ${entry.path}`);
        await rm(target, { force: true });
      }
      entry.state = 'removed';
      entry.updatedAt = new Date().toISOString();
      await persist();
      if (await exists(target)) throw new PolicyError(`cleanup failed to remove ${entry.path}`);
      entry.state = 'verified-absent';
      entry.updatedAt = new Date().toISOString();
      await persist();
    }
  }

  async #assert(assertion, results, workspace) {
    const result = assertion.operation ? results.get(assertion.operation) : null;
    const fail = (message) => { throw new PolicyError(`controller assertion failed: ${message}`); };
    if (assertion.kind === 'exit-equals' && result.exitCode !== assertion.value) fail(`${assertion.operation} exit ${result.exitCode} != ${assertion.value}`);
    if (assertion.kind === 'exit-not-equals' && result.exitCode === assertion.value) fail(`${assertion.operation} exit unexpectedly equals ${assertion.value}`);
    if (assertion.kind === 'stdout-equals' && result.stdout !== assertion.value) fail(`${assertion.operation} stdout differs`);
    if (assertion.kind === 'stdout-contains' && !result.stdout.includes(assertion.value)) fail(`${assertion.operation} stdout missing marker`);
    if (assertion.kind === 'stderr-equals' && result.stderr !== assertion.value) fail(`${assertion.operation} stderr differs`);
    if (assertion.kind === 'stderr-contains' && !result.stderr.includes(assertion.value)) fail(`${assertion.operation} stderr missing marker`);
    if (assertion.kind === 'outputs-equal') {
      const left = results.get(assertion.leftOperation);
      const right = results.get(assertion.rightOperation);
      if (left[assertion.stream] !== right[assertion.stream]) fail(`${assertion.leftOperation}/${assertion.rightOperation} ${assertion.stream} differs`);
    }
    if (assertion.kind === 'file-exists' || assertion.kind === 'file-absent' || assertion.kind === 'file-sha256') {
      const target = await assertContainedNoFollow(workspace.worktreeDir, assertion.path);
      const present = await exists(target);
      if (assertion.kind === 'file-exists' && !present) fail(`${assertion.path} does not exist`);
      if (assertion.kind === 'file-absent' && present) fail(`${assertion.path} exists`);
      if (assertion.kind === 'file-sha256') {
        if (!present) fail(`${assertion.path} does not exist`);
        if (await fileDigest(target) !== assertion.sha256) fail(`${assertion.path} SHA-256 differs`);
      }
    }
    if (assertion.kind === 'json-field-equals') {
      let parsed;
      try { parsed = JSON.parse(result[assertion.stream]); }
      catch { fail(`${assertion.operation} ${assertion.stream} is not JSON`); }
      const located = primitiveAtPath(parsed, assertion.field);
      if (!located.found || !Object.is(located.value, assertion.value)) fail(`${assertion.operation} JSON field ${assertion.field} differs`);
    }
    if (assertion.kind === 'workspace-clean') {
      const snapshot = await this.#workspace.snapshot(workspace);
      if (snapshot.dirty) fail('workspace is dirty');
    }
  }

  async execute({ plan, state, workspace, persist, onLiveness = null }) {
    state.controllerPlan ??= {
      protocol: plan.protocol,
      phase: 'materializing',
      files: [],
      operations: [],
      cleanupLedger: [],
      assertionsPassed: 0,
      startedAt: new Date().toISOString()
    };
    const planState = state.controllerPlan;
    const results = new Map((planState.operations ?? []).filter((entry) => entry.result).map((entry) => [entry.id, entry.result]));

    try {
      for (const file of plan.files) {
        const existing = planState.files.find((entry) => entry.path === file.path);
        if (existing?.state === 'applied') continue;
        let fileState = existing;
        if (!fileState) {
          fileState = { path: file.path, scope: file.scope, action: file.action, state: 'planned', updatedAt: new Date().toISOString() };
          planState.files.push(fileState);
          if (file.scope === 'ephemeral') {
            planState.cleanupLedger.push({ path: file.path, state: 'planned', updatedAt: new Date().toISOString() });
          }
          await persist();
        }
        const applied = await this.#applyFile(file, { state, workspace });
        fileState.state = 'applied';
        fileState.digest = applied.digest;
        fileState.reconciled = applied.reconciled === true;
        fileState.updatedAt = new Date().toISOString();
        const ledgerEntry = planState.cleanupLedger.find((entry) => entry.path === file.path);
        if (ledgerEntry) {
          ledgerEntry.state = file.action === 'reserve' ? 'planned' : 'created';
          ledgerEntry.updatedAt = new Date().toISOString();
        }
        await persist();
      }

      planState.phase = 'running-operations';
      await persist();
      for (const operation of plan.operations) {
        const prior = planState.operations.find((entry) => entry.id === operation.id);
        if (prior?.state === 'observed' && prior.result) {
          results.set(operation.id, prior.result);
          continue;
        }
        this.#registry.validate(operation.operation, operation.params);
        const record = prior ?? { id: operation.id, operation: operation.operation, state: 'planned' };
        if (!prior) planState.operations.push(record);
        record.state = 'attempted';
        record.attemptedAt = new Date().toISOString();
        await persist();
        const result = await this.#registry.execute(operation.operation, operation.params, {
          projectDir: workspace.worktreeDir,
          processRunner: this.#processRunner,
          onActivity: (activity) => onLiveness?.({ operationId: operation.id, operation: operation.operation, ...activity })
        });
        const evidence = operationResultEvidence(operation.id, operation.operation, result);
        record.result = evidence;
        record.state = 'observed';
        record.observedAt = new Date().toISOString();
        results.set(operation.id, evidence);
        await persist();
        if (evidence.timedOut) throw new PolicyError(`deterministic operation ${operation.id} timed out`);
      }

      planState.phase = 'asserting';
      await persist();
      for (let index = planState.assertionsPassed ?? 0; index < plan.assertions.length; index += 1) {
        await this.#assert(plan.assertions[index], results, workspace);
        planState.assertionsPassed = index + 1;
        await persist();
      }
    } finally {
      planState.phase = 'cleaning';
      await persist();
      await this.#cleanup(state, workspace, persist);
    }

    const snapshot = await this.#workspace.validate(workspace);
    const actual = [...snapshot.changedFiles].sort();
    const expected = [...plan.expectedChangedPaths].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new PolicyError(`controller plan changed-path set mismatch; expected [${expected.join(', ')}], observed [${actual.join(', ')}]`);
    }
    planState.phase = 'complete';
    planState.completedAt = new Date().toISOString();
    planState.cleanup = {
      created: planState.cleanupLedger.filter((entry) => ['created', 'removed', 'verified-absent'].includes(entry.state)).length,
      removed: planState.cleanupLedger.filter((entry) => ['removed', 'verified-absent'].includes(entry.state)).length,
      verifiedAbsent: planState.cleanupLedger.filter((entry) => entry.state === 'verified-absent').length,
      leftovers: planState.cleanupLedger.filter((entry) => entry.state !== 'verified-absent').map((entry) => entry.path)
    };
    await persist();
    return {
      snapshot,
      tests: planState.operations.map((entry) => ({
        operation: entry.operation,
        id: entry.id,
        exitCode: entry.result?.exitCode ?? null,
        timedOut: entry.result?.timedOut === true
      })),
      summary: `Controller plan completed ${planState.operations.length} deterministic operations and ${planState.assertionsPassed} assertions; cleanup verified ${planState.cleanup.verifiedAbsent}/${planState.cleanupLedger.length} ephemeral paths absent.`
    };
  }
}
