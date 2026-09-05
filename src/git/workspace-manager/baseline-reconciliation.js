function lines(value) {
  return String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export class BaselineReconciliation {
  #run;
  #validate;
  #normalizeIdentity;
  #rebaseArguments;
  #errors;

  constructor({ run, validate, normalizeIdentity, rebaseArguments, errors }) {
    this.#run = run;
    this.#validate = validate;
    this.#normalizeIdentity = normalizeIdentity;
    this.#rebaseArguments = rebaseArguments;
    this.#errors = { ...errors };
  }

  async reconcile(workspace, { before, current }) {
    const fromBaseSha = this.#normalizeIdentity(workspace.publicationBaseSha ?? workspace.baseSha, 'publication baseline');
    if (current.baseSha === fromBaseSha) {
      return {
        changed: false,
        fromBaseSha,
        toBaseSha: fromBaseSha,
        fromHeadSha: before.headSha,
        toHeadSha: before.headSha,
        snapshot: before,
      };
    }

    const upstreamFastForward = await this.#run(['merge-base', '--is-ancestor', fromBaseSha, current.baseSha], {
      cwd: workspace.repoDir,
      allowFailure: true,
    });
    if (upstreamFastForward.exitCode === 1) {
      throw this.#errors.historyRewrite({ fromBaseSha, toBaseSha: current.baseSha, fromHeadSha: before.headSha, baseRef: workspace.baseRef });
    }
    if (upstreamFastForward.exitCode !== 0) throw this.#errors.compareBaseline(upstreamFastForward.stderr || upstreamFastForward.stdout);

    const candidateDescends = await this.#run(['merge-base', '--is-ancestor', fromBaseSha, before.headSha], {
      cwd: workspace.repoDir,
      allowFailure: true,
    });
    if (candidateDescends.exitCode === 1) throw this.#errors.candidateAncestry();
    if (candidateDescends.exitCode !== 0) throw this.#errors.compareCandidate(candidateDescends.stderr || candidateDescends.stdout);

    const fromHeadSha = this.#normalizeIdentity(before.headSha, 'candidate head');
    if (fromHeadSha === fromBaseSha) {
      await this.#run(['reset', '--hard', current.baseSha], { cwd: workspace.worktreeDir });
    } else {
      const rebased = await this.#run(this.#rebaseArguments({ current: current.baseSha, previous: fromBaseSha, branch: workspace.branch }), {
        cwd: workspace.worktreeDir,
        allowFailure: true,
      });
      if (rebased.exitCode !== 0) {
        const conflicted = await this.#run(['diff', '--name-only', '--diff-filter=U'], {
          cwd: workspace.worktreeDir,
          allowFailure: true,
        });
        const files = lines(conflicted.stdout);
        const aborted = await this.#run(['rebase', '--abort'], { cwd: workspace.worktreeDir, allowFailure: true });
        if (aborted.exitCode !== 0) throw this.#errors.abort(aborted.stderr || aborted.stdout);
        const restoredHead = this.#normalizeIdentity(
          (await this.#run(['rev-parse', 'HEAD'], { cwd: workspace.worktreeDir })).stdout.trim(),
          'restored candidate head',
        );
        if (restoredHead !== fromHeadSha) throw this.#errors.restoreMismatch();
        throw this.#errors.conflict({
          baseRef: current.baseRef,
          files,
          fromBaseSha,
          toBaseSha: current.baseSha,
          fromHeadSha,
        });
      }
    }

    const toHeadSha = this.#normalizeIdentity(
      (await this.#run(['rev-parse', 'HEAD'], { cwd: workspace.worktreeDir })).stdout.trim(),
      'rebased candidate head',
    );
    workspace.publicationBaseSha = current.baseSha;
    const snapshot = await this.#validate(workspace);
    if (snapshot.dirty) throw this.#errors.becameDirty();
    return {
      changed: true,
      fromBaseSha,
      toBaseSha: current.baseSha,
      fromHeadSha,
      toHeadSha,
      snapshot,
    };
  }
}
