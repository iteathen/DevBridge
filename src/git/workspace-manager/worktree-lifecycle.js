import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function sameIdentity(left, right) {
  const [canonicalLeft, canonicalRight] = await Promise.all([realpath(left), realpath(right)]);
  return canonicalLeft === canonicalRight;
}

export class WorktreeLifecycle {
  #run;
  #assertContained;
  #errors;

  constructor({ run, assertContained, errors }) {
    this.#run = run;
    this.#assertContained = assertContained;
    this.#errors = { ...errors };
  }

  async prepare({ repositoryLocation, location, branch, baseline }) {
    await this.#assertContained(location);
    await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });

    if (await exists(location)) {
      const top = (await this.#run(['rev-parse', '--show-toplevel'], { cwd: location })).stdout.trim();
      if (!(await sameIdentity(top, location))) throw this.#errors.identityMismatch();
      const currentBranch = (await this.#run(['branch', '--show-current'], { cwd: location })).stdout.trim();
      if (currentBranch !== branch) throw this.#errors.branchMismatch(currentBranch);
      return;
    }

    const branchExists = await this.#run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repositoryLocation,
      allowFailure: true,
    });
    if (branchExists.exitCode === 0) {
      await this.#run(['worktree', 'add', '--', location, branch], { cwd: repositoryLocation });
    } else {
      await this.#run(['worktree', 'add', '-b', branch, '--', location, baseline], { cwd: repositoryLocation });
    }
  }
}
