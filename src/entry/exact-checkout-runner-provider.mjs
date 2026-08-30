import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

const FIXED_REMOTE = 'https://github.com/iteathen/DevBridge.git';
const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const EXACT_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_ENTRY_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_BYTES = 256 * 1024;
const PUBLISH_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const PUBLISH_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80, 160]);
const CHECKOUT_ID_DOMAIN = 'devbridge/exact-checkout-cache-v1';
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');

function fail(message) { throw new Error(message); }

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`${name} contract is incomplete`);
  }
  return value;
}

function normalizedSubject(input, normalize) {
  const subject = normalize(input);
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) fail('exact checkout subject is invalid');
  if (!EXACT_HEAD.test(subject.head) || !EXACT_DIGEST.test(subject.sha256)) fail('exact checkout subject identity is invalid');
  return Object.freeze({ ...subject });
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkoutIdentity(subject) {
  return createHash('sha256')
    .update(CHECKOUT_ID_DOMAIN)
    .update('\0')
    .update(subject.head)
    .update('\0')
    .update(subject.sha256)
    .digest('hex');
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function requireRealDirectory(candidate, name) {
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${name} must be a real directory`);
  return realpath(candidate);
}

async function requireRegularFile(root, relative, name, maxBytes = MAX_ENTRY_BYTES) {
  const candidate = path.join(root, ...relative.split('/'));
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maxBytes) fail(`${name} is invalid`);
  const actual = await realpath(candidate);
  const rel = path.relative(root, actual);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail(`${name} escaped the exact checkout`);
  return { path: actual, bytes: await readFile(actual) };
}

async function emptyFile(file) {
  let info;
  try { info = await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return 'absent'; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 0) return 'invalid';
  return (await readFile(file)).length === 0 ? 'valid' : 'invalid';
}

function defaultRun(program, args, { cwd, env }) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
  });
  return {
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error ?? null,
  };
}

function defaultLaunch(entry, argv, { cwd, env }) {
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: false,
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function gitEnvironment(home) {
  const names = process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']
    : ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];
  const env = {};
  for (const name of names) if (typeof process.env[name] === 'string') env[name] = process.env[name];
  env.HOME = home;
  if (process.platform === 'win32') env.USERPROFILE = home;
  env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_COUNT = '3';
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  env.GIT_CONFIG_VALUE_0 = env.GIT_CONFIG_GLOBAL;
  env.GIT_CONFIG_KEY_1 = 'core.fsmonitor';
  env.GIT_CONFIG_VALUE_1 = 'false';
  env.GIT_CONFIG_KEY_2 = 'credential.helper';
  env.GIT_CONFIG_VALUE_2 = '';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  return env;
}

async function runChecked(run, args, context, label) {
  const result = await run('git', args, context);
  if (!result || result.exitCode !== 0 || result.timedOut === true || result.error) fail(`exact checkout ${label} failed`);
  return result;
}

async function publishDirectory(temporary, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      if (await exists(destination)) fail('exact checkout preserved a conflicting cache publication');
      const retry = process.platform === 'win32'
        && PUBLISH_RETRY_CODES.has(error?.code)
        && attempt < PUBLISH_RETRY_DELAYS_MS.length;
      if (!retry) throw error;
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export class ExactCheckoutRunnerProvider {
  #root;
  #run;
  #launch;
  #allowFetch;
  #admitSubject;
  #ownership;
  #artifacts;
  #normalize;

  constructor({
    cacheRoot,
    ownership,
    artifacts,
    normalizeSubject,
    run = defaultRun,
    launch = defaultLaunch,
    allowFetch = true,
    admitSubject = null,
  } = {}) {
    if (typeof cacheRoot !== 'string' || !path.isAbsolute(cacheRoot)) throw new TypeError('exact checkout cacheRoot must be an absolute local path');
    if (typeof run !== 'function' || typeof launch !== 'function') throw new TypeError('exact checkout execution ports must be functions');
    if (typeof allowFetch !== 'boolean') throw new TypeError('exact checkout allowFetch must be a boolean');
    if (admitSubject != null && typeof admitSubject !== 'function') throw new TypeError('exact checkout admitSubject must be a function');
    if (typeof normalizeSubject !== 'function') throw new TypeError('exact checkout subject contract is incomplete');
    this.#root = path.resolve(cacheRoot);
    this.#run = run;
    this.#launch = launch;
    this.#allowFetch = allowFetch;
    this.#admitSubject = admitSubject;
    this.#ownership = requirePort(ownership, ['withActivity', 'duringActivity', 'observe'], 'exact checkout ownership');
    this.#artifacts = requirePort(artifacts, ['plan', 'discover', 'observe', 'remove'], 'exact checkout artifact action');
    this.#normalize = normalizeSubject;
  }

  async #context(root, home) {
    return { cwd: await requireRealDirectory(root, 'exact checkout cache root'), env: gitEnvironment(await requireRealDirectory(home, 'exact checkout control home')) };
  }

  async #verify(directory, subject, context) {
    const root = await requireRealDirectory(directory, 'exact checkout');
    const git = path.join(root, '.git');
    const gitInfo = await lstat(git);
    if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) fail('exact checkout Git identity is invalid');

    const headResult = await runChecked(this.#run, ['-C', root, 'rev-parse', '--verify', 'HEAD'], context, 'head verification');
    if (headResult.stdout.trim().toLowerCase() !== subject.head) fail('exact checkout resolved a different exact head');
    const status = await runChecked(this.#run, ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], context, 'cleanliness verification');
    if (status.stdout.trim() !== '') fail('exact checkout is not clean');

    await requireRegularFile(root, 'devbridge.mjs', 'exact checkout runner artifact');
    const artifact = await runChecked(
      this.#run,
      ['-C', root, 'cat-file', 'blob', `${subject.head}:devbridge.mjs`],
      context,
      'runner artifact verification',
    );
    if (digest(Buffer.from(artifact.stdout, 'utf8')) !== subject.sha256) fail('exact checkout runner artifact digest differs from the exact subject');
    const entry = await requireRegularFile(root, 'src/cli.js', 'exact checkout control-plane entry');
    return { root, entry: entry.path };
  }

  async #ensureControlFile(session, home) {
    const identity = 'cache.file.control';
    const file = path.join(home, 'gitconfig');
    const request = Object.freeze({ kind: 'file', location: path.resolve(file), sha256: EMPTY_DIGEST });
    let current = await session.read(identity);
    if (current?.value.phase === 'complete') {
      if (!isDeepStrictEqual(current.value.request, request) || await emptyFile(file) !== 'valid') {
        fail('exact checkout control receipt does not match local state');
      }
      const observed = await this.#artifacts.observe(structuredClone(current.value.value));
      if (observed.state !== 'present') fail('exact checkout control descriptor does not match local state');
      return;
    }
    const observed = await emptyFile(file);
    if (!current && observed === 'invalid') fail('exact checkout found an invalid unowned control file');
    if (!current) current = await session.reserve({ identity, provenance: observed === 'valid' ? 'adopted' : 'created', request });
    if (!isDeepStrictEqual(current.value.request, request)) fail('exact checkout has another pending control request');
    if (observed === 'absent') await writeFile(file, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (await emptyFile(file) !== 'valid') fail('exact checkout control file is invalid');
    const value = await this.#artifacts.plan({
      identity,
      root: home,
      files: [{ relative: 'gitconfig', bytes: 0, sha256: EMPTY_DIGEST }],
      directories: [],
      exclusive: false,
      removeRoot: false,
    });
    await session.complete({ reservation: current, value });
  }

  async #completeCheckout(session, current, request, identity, destination, subject, context) {
    if (!isDeepStrictEqual(current.value.request, request)) fail('exact checkout receipt conflicts with its exact local request');
    await this.#verify(destination, subject, context);
    if (current.value.phase === 'complete') {
      const observed = await this.#artifacts.observe(structuredClone(current.value.value));
      if (observed.state !== 'present') fail('exact checkout receipt descriptor does not match local state');
      return;
    }
    const value = await this.#artifacts.discover({ identity, root: destination });
    await session.complete({ reservation: current, value });
  }

  async #cleanupTemporary(temporary, identity) {
    if (!(await exists(temporary))) return;
    const value = await this.#artifacts.discover({ identity: `cache.temporary.${identity}`, root: temporary });
    await this.#artifacts.remove(value);
  }

  async #prepareWithin(session, subject) {
    await session.directory({ identity: 'cache.directory.root', location: this.#root });
    const checkouts = path.join(this.#root, 'checkouts');
    const home = path.join(this.#root, 'control-home');
    await session.directory({ identity: 'cache.directory.checkouts', location: checkouts });
    await session.directory({ identity: 'cache.directory.control', location: home });
    await this.#ensureControlFile(session, home);
    const context = await this.#context(this.#root, home);
    const selected = checkoutIdentity(subject);
    const identity = `cache.checkout.${selected}`;
    const destination = path.join(checkouts, selected);
    const request = Object.freeze({
      kind: 'tree',
      location: path.resolve(destination),
      head: subject.head,
      sha256: subject.sha256,
    });
    let current = await session.read(identity);

    if (current?.value.phase === 'complete') {
      await this.#completeCheckout(session, current, request, identity, destination, subject, context);
      return { destination, context };
    }

    if (!current && await exists(destination)) {
      await this.#verify(destination, subject, context);
      current = await session.reserve({ identity, provenance: 'adopted', request });
      await this.#completeCheckout(session, current, request, identity, destination, subject, context);
      return { destination, context };
    }
    if (!current) {
      if (!this.#allowFetch) fail('exact checkout is unavailable and runner refresh is disabled');
      current = await session.reserve({ identity, provenance: 'created', request });
    }
    if (!isDeepStrictEqual(current.value.request, request)) fail('exact checkout has another pending exact local request');

    if (await exists(destination)) {
      await this.#completeCheckout(session, current, request, identity, destination, subject, context);
      return { destination, context };
    }
    if (!this.#allowFetch) fail('exact checkout is unavailable and runner refresh is disabled');

    const temporary = path.join(checkouts, `.prepare-${current.value.operation}.tmp`);
    if (await exists(temporary)) {
      try { await this.#verify(temporary, subject, context); }
      catch { fail('exact checkout preserved ambiguous pending material'); }
    } else {
      await mkdir(temporary, { mode: 0o700 });
      try {
        await runChecked(this.#run, ['init', '--quiet', temporary], context, 'initialization');
        await runChecked(this.#run, ['-C', temporary, 'fetch', '--no-tags', '--depth', '1', FIXED_REMOTE, subject.head], context, 'exact fetch');
        await runChecked(this.#run, ['-C', temporary, 'checkout', '--detach', '--force', subject.head], context, 'exact checkout');
        await this.#verify(temporary, subject, context);
      } catch (error) {
        try {
          await this.#cleanupTemporary(temporary, selected);
          await session.clear({ item: current });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'exact checkout preserved ambiguous pending material');
        }
        throw error;
      }
    }

    await publishDirectory(temporary, destination);
    await this.#completeCheckout(session, current, request, identity, destination, subject, context);
    return { destination, context };
  }

  async prepare(input) {
    const subject = normalizedSubject(input, this.#normalize);
    if (this.#admitSubject) await this.#admitSubject(subject);
    const prepared = await this.#ownership.withActivity((session) => this.#prepareWithin(session, subject));
    const provider = this;
    return Object.freeze({
      subject,
      async launch(argv) {
        if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string')) fail('exact checkout launch argv must be an array of strings');
        return provider.#ownership.duringActivity(async () => {
          const current = await provider.#verify(prepared.destination, subject, prepared.context);
          return await provider.#launch(current.entry, [...argv], { cwd: current.root, env: { ...process.env } });
        });
      },
    });
  }
}
