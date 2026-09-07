function lines(value) {
  return String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export class WorkspaceObservation {
  #run;
  #normalizeIdentity;
  #reserved;
  #errors;

  constructor({ run, normalizeIdentity, reserved, errors }) {
    this.#run = run;
    this.#normalizeIdentity = normalizeIdentity;
    this.#reserved = reserved;
    this.#errors = { ...errors };
  }

  async observe(workspace) {
    const { worktreeDir, baseSha } = workspace;
    const publicationBaseSha = this.#normalizeIdentity(workspace.publicationBaseSha ?? baseSha, 'publication baseline');
    const head = await this.#run(['rev-parse', 'HEAD'], { cwd: worktreeDir });
    const status = await this.#run(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktreeDir });
    const committed = await this.#run(['diff', '--name-only', `${publicationBaseSha}...HEAD`], { cwd: worktreeDir });
    const staged = await this.#run(['diff', '--cached', '--name-only'], { cwd: worktreeDir });
    const unstaged = await this.#run(['diff', '--name-only'], { cwd: worktreeDir });
    const untracked = await this.#run(['ls-files', '--others', '--exclude-standard'], { cwd: worktreeDir });
    const unmerged = await this.#run(['diff', '--name-only', '--diff-filter=U'], { cwd: worktreeDir });
    const changedFiles = [...new Set([
      ...lines(committed.stdout),
      ...lines(staged.stdout),
      ...lines(unstaged.stdout),
      ...lines(untracked.stdout),
    ])].sort();

    return {
      branch: workspace.branch,
      baseSha,
      publicationBaseSha,
      headSha: head.stdout.trim(),
      dirty: status.stdout.trim() !== '',
      changedFiles,
      unmergedFiles: lines(unmerged.stdout),
      status: status.stdout.trim(),
    };
  }

  async validate(workspace) {
    const snapshot = await this.observe(workspace);
    if (snapshot.unmergedFiles.length > 0) throw this.#errors.unmerged(snapshot.unmergedFiles);
    const reserved = snapshot.changedFiles.filter(this.#reserved);
    if (reserved.length > 0) throw this.#errors.reserved(reserved);

    const committed = await this.#run(['diff', '--check', `${snapshot.publicationBaseSha}...HEAD`], {
      cwd: workspace.worktreeDir,
      allowFailure: true,
    });
    const staged = await this.#run(['diff', '--cached', '--check'], {
      cwd: workspace.worktreeDir,
      allowFailure: true,
    });
    const unstaged = await this.#run(['diff', '--check'], {
      cwd: workspace.worktreeDir,
      allowFailure: true,
    });
    if (committed.exitCode !== 0 || staged.exitCode !== 0 || unstaged.exitCode !== 0) {
      const detail = committed.stderr || committed.stdout || staged.stderr || staged.stdout || unstaged.stderr || unstaged.stdout;
      throw this.#errors.diffCheck(detail.trim());
    }
    return snapshot;
  }
}
