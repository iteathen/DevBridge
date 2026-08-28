const SHA_RE = /^[0-9a-f]{40}$/u;
const MAX_KNOWN_HEADS = 16;

function lines(value) {
  return String(value).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function authorizationBase(value) {
  try {
    return `${new URL(value).origin}/`;
  } catch {
    return null;
  }
}

export class PublicationTransaction {
  #run;
  #timeoutMs;
  #normalizeIdentity;
  #error;
  #unexpectedHead;

  constructor({ run, timeoutMs, normalizeIdentity, error, unexpectedHead }) {
    this.#run = run;
    this.#timeoutMs = timeoutMs;
    this.#normalizeIdentity = normalizeIdentity;
    this.#error = error;
    this.#unexpectedHead = unexpectedHead;
  }

  normalizeKnown(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > MAX_KNOWN_HEADS) {
      throw this.#error(`persisted known task-branch heads must contain at most ${MAX_KNOWN_HEADS} commit SHAs`);
    }
    return [...new Set(value.map((entry) => this.#normalizeIdentity(entry, 'known task-branch head')))];
  }

  async #observe(workspace, credential, ref) {
    const observed = await this.#run(['ls-remote', '--heads', 'origin', ref], {
      cwd: workspace.worktreeDir,
      token: credential,
      authBaseUrl: authorizationBase(workspace.remoteUrl),
      timeoutMs: this.#timeoutMs,
    });
    const entries = lines(observed.stdout);
    if (entries.length === 0) return null;
    if (entries.length !== 1) throw this.#error(`remote task branch observation returned multiple refs for ${ref}`);
    const [sha, observedRef] = entries[0].split(/\s+/u);
    if (observedRef !== ref) throw this.#error(`remote task branch observation returned unexpected ref ${observedRef}`);
    return this.#normalizeIdentity(sha, 'remote task branch head');
  }

  #remember(workspace, headSha) {
    workspace.taskBranchKnownRemoteHeads = this.normalizeKnown([
      ...(workspace.taskBranchKnownRemoteHeads ?? []),
      headSha,
    ].slice(-MAX_KNOWN_HEADS));
  }

  async publish(workspace, { snapshot, expectedHeadSha, ref, credential }) {
    const localHead = this.#normalizeIdentity(snapshot.headSha, 'local task branch head');
    if (expectedHeadSha != null) {
      const expectedHead = this.#normalizeIdentity(expectedHeadSha, 'expected verified task branch head');
      if (localHead !== expectedHead) {
        throw this.#error(`local task branch head ${localHead} differs from the exact verified publication head ${expectedHead}; fresh verification is required`);
      }
    }
    const remoteHead = await this.#observe(workspace, credential, ref);
    if (remoteHead === localHead) {
      this.#remember(workspace, localHead);
      return { branch: workspace.branch, headSha: localHead, reconciled: true, previousRemoteHeadSha: remoteHead };
    }

    const known = new Set(this.normalizeKnown(workspace.taskBranchKnownRemoteHeads));
    let expectation;
    if (remoteHead == null) expectation = '';
    else if (known.has(remoteHead)) expectation = remoteHead;
    else throw this.#unexpectedHead(remoteHead);

    const pushed = await this.#run([
      'push', `--force-with-lease=${ref}:${expectation}`, 'origin', `${localHead}:${ref}`,
    ], {
      cwd: workspace.worktreeDir,
      token: credential,
      authBaseUrl: authorizationBase(workspace.remoteUrl),
      timeoutMs: this.#timeoutMs,
      allowFailure: true,
    });

    const reconciledHead = await this.#observe(workspace, credential, ref);
    if (reconciledHead !== localHead) {
      throw this.#error(`task branch publication did not converge on the exact local head: ${(pushed.stderr || pushed.stdout).trim()}`);
    }
    this.#remember(workspace, localHead);
    return {
      branch: workspace.branch,
      headSha: localHead,
      reconciled: pushed.exitCode !== 0 || pushed.timedOut === true,
      previousRemoteHeadSha: remoteHead,
    };
  }
}
