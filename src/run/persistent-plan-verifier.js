import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { PolicyError } from '../errors.js';
import { assertNoFollowWithin, pathExists } from '../security/no-follow-path.js';

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function verifyPersistentPlanFiles(plan, worktreeDir) {
  const evidence = [];
  for (const file of plan.files.filter((entry) => entry.scope === 'persistent')) {
    const target = await assertNoFollowWithin(worktreeDir, file.path, { allowMissing: true });
    const present = await pathExists(target);

    if (file.action === 'delete') {
      if (present) throw new PolicyError(`planned delete target was recreated after execution: ${file.path}`);
      evidence.push({ path: file.path, action: file.action, state: 'verified-absent', sha256: null });
      continue;
    }

    if (!['create', 'replace'].includes(file.action)) {
      throw new PolicyError(`unsupported persistent verification action ${file.action}`);
    }
    if (!present) throw new PolicyError(`planned persistent file is missing after execution: ${file.path}`);
    await assertNoFollowWithin(worktreeDir, file.path, { allowMissing: false });
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new PolicyError(`planned persistent path is not a regular file: ${file.path}`);
    const observed = digest(await readFile(target));
    if (observed !== file.contentSha256) {
      throw new PolicyError(`planned persistent file SHA-256 changed after execution: ${file.path}`);
    }
    evidence.push({ path: file.path, action: file.action, state: 'verified-exact', sha256: observed });
  }
  return evidence;
}

export class PersistentPlanVerifyingExecutor {
  #delegate;

  constructor({ delegate }) {
    if (!delegate || typeof delegate.execute !== 'function') throw new TypeError('persistent-plan verifier delegate is required');
    this.#delegate = delegate;
  }

  async execute(input) {
    const result = await this.#delegate.execute(input);
    try {
      const evidence = await verifyPersistentPlanFiles(input.plan, input.workspace.worktreeDir);
      input.state.controllerPlan ??= {};
      input.state.controllerPlan.finalFileVerification = {
        state: 'verified',
        verifiedAt: new Date().toISOString(),
        files: evidence,
      };
      await input.persist();
      return {
        ...result,
        summary: `${result.summary} Final persistent plan bytes verified for ${evidence.length} path(s).`,
      };
    } catch (error) {
      input.state.controllerPlan ??= {};
      input.state.controllerPlan.phase = 'final-byte-rejected';
      input.state.controllerPlan.finalFileVerification = {
        state: 'rejected',
        rejectedAt: new Date().toISOString(),
        reason: error.message,
      };
      await input.persist();
      throw error;
    }
  }
}
