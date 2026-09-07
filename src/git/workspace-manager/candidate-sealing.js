function lines(value) {
  return String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export class CandidateSealing {
  #run;
  #observe;
  #validate;
  #reserved;
  #commitArguments;
  #errors;

  constructor({ run, observe, validate, reserved, commitArguments, errors }) {
    this.#run = run;
    this.#observe = observe;
    this.#validate = validate;
    this.#reserved = reserved;
    this.#commitArguments = commitArguments;
    this.#errors = { ...errors };
  }

  async #restoreIndex(workspace) {
    const reset = await this.#run(['reset', '--quiet', 'HEAD', '--', '.'], {
      cwd: workspace.worktreeDir,
      allowFailure: true,
    });
    if (reset.exitCode !== 0) throw this.#errors.restore(reset.stderr || reset.stdout);
  }

  async #validateProposal(workspace) {
    try {
      return await this.#validate(workspace);
    } catch (error) {
      throw this.#errors.proposal(error);
    }
  }

  async seal(workspace, metadata) {
    let snapshot = await this.#observe(workspace);
    if (snapshot.dirty) {
      await this.#restoreIndex(workspace);
      snapshot = await this.#validateProposal(workspace);

      if (snapshot.dirty) {
        let committed = false;
        try {
          await this.#run(['add', '-A', '--', '.'], { cwd: workspace.worktreeDir });
          const staged = await this.#run(['diff', '--cached', '--name-only'], { cwd: workspace.worktreeDir });
          const stagedFiles = lines(staged.stdout);
          const reserved = stagedFiles.filter(this.#reserved);
          if (reserved.length > 0) throw this.#errors.reserved(reserved);
          if (stagedFiles.length === 0) {
            await this.#restoreIndex(workspace);
          } else {
            const check = await this.#run(['diff', '--cached', '--check'], {
              cwd: workspace.worktreeDir,
              allowFailure: true,
            });
            if (check.exitCode !== 0) throw this.#errors.diffCheck(check.stderr || check.stdout);
            await this.#run(this.#commitArguments(metadata), { cwd: workspace.worktreeDir });
            committed = true;
          }
        } catch (error) {
          if (!committed) await this.#restoreIndex(workspace);
          throw error;
        }
      }
    }

    snapshot = await this.#validate(workspace);
    if (snapshot.dirty) throw this.#errors.remainedDirty();
    return snapshot;
  }
}
