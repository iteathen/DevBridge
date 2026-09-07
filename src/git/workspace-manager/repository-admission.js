import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
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

function normalizedLocation(value) {
  return String(value).replace(/\\/gu, '/').replace(/\/$/u, '');
}

function authorizationBase(value) {
  try {
    return `${new URL(value).origin}/`;
  } catch {
    return null;
  }
}

export class RepositoryAdmission {
  #run;
  #allowCreate;
  #assertContained;
  #location;
  #remote;
  #credential;
  #timeoutMs;
  #excludedPath;
  #normalizeIdentity;
  #errors;

  constructor({ run, allowCreate, assertContained, location, remote, credential, timeoutMs, excludedPath, normalizeIdentity, errors }) {
    this.#run = run;
    this.#allowCreate = allowCreate;
    this.#assertContained = assertContained;
    this.#location = location;
    this.#remote = remote;
    this.#credential = credential;
    this.#timeoutMs = timeoutMs;
    this.#excludedPath = excludedPath;
    this.#normalizeIdentity = normalizeIdentity;
    this.#errors = { ...errors };
  }

  async #ensureExclusion(location) {
    const resolved = (await this.#run(['rev-parse', '--git-path', 'info/exclude'], { cwd: location })).stdout.trim();
    const file = path.resolve(location, resolved);
    await this.#assertContained(file);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const entries = new Set(text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
    if (!entries.has(this.#excludedPath)) {
      const prefix = text !== '' && !text.endsWith('\n') ? '\n' : '';
      await appendFile(file, `${prefix}${this.#excludedPath}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }

  async admit(subject) {
    const location = this.#location(subject);
    const remote = this.#remote(subject);
    const credential = await this.#credential();
    await this.#assertContained(location);

    if (!(await exists(path.join(location, '.git')))) {
      if (!this.#allowCreate()) throw this.#errors.creationDenied(subject);
      const parent = path.dirname(location);
      await this.#assertContained(parent);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await this.#run(['clone', '--no-checkout', '--origin', 'origin', '--', remote, location], {
        cwd: parent,
        token: credential,
        authBaseUrl: authorizationBase(remote),
        timeoutMs: this.#timeoutMs,
      });
    }

    const observedRemote = (await this.#run(['remote', 'get-url', 'origin'], { cwd: location })).stdout.trim();
    if (normalizedLocation(observedRemote) !== normalizedLocation(remote)) {
      throw this.#errors.remoteMismatch({ location, remote, observedRemote });
    }

    await this.#ensureExclusion(location);
    await this.#run(['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'], {
      cwd: location,
      token: credential,
      authBaseUrl: authorizationBase(remote),
      timeoutMs: this.#timeoutMs,
    });

    let head = await this.#run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: location,
      allowFailure: true,
    });
    if (head.exitCode !== 0 || !head.stdout.trim()) {
      await this.#run(['remote', 'set-head', 'origin', '--auto'], { cwd: location, allowFailure: true });
      head = await this.#run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
        cwd: location,
        allowFailure: true,
      });
    }
    const baseRef = head.stdout.trim();
    if (!baseRef.startsWith('origin/')) throw this.#errors.defaultReference({ location, head });
    const baseSha = this.#normalizeIdentity(
      (await this.#run(['rev-parse', baseRef], { cwd: location })).stdout.trim(),
      'repository baseline',
    );

    return {
      repository: subject,
      repoDir: location,
      remoteUrl: remote,
      baseRef,
      baseSha,
      baselineChannel: null,
      defaultBranch: baseRef.slice('origin/'.length),
    };
  }
}
