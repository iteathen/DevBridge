import { redactText } from '../security/redaction.js';

const SHA = /^[a-f0-9]{40,64}$/u;
const MAX_REPOSITORIES = 64;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;
const WINDOWS_UNC_PATH = /^\\\\/u;

function textOf(result) {
  return `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`.slice(-64 * 1024);
}

function subcommand(args) {
  if (!Array.isArray(args)) return null;
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value === '-c') {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    return { value, index };
  }
  return null;
}

export function repositoryAdmissionPhase(args) {
  const command = subcommand(args);
  if (!command) return null;
  const tail = args.slice(command.index + 1).map(String);
  switch (command.value) {
    case 'clone': return 'clone';
    case 'fetch': return 'fetch';
    case 'ls-remote': return 'remote-access';
    case 'remote':
      if (tail[0] === 'get-url') return 'origin';
      if (tail[0] === 'set-head') return 'default-ref';
      return null;
    case 'symbolic-ref':
      return tail.some((entry) => entry.includes('refs/remotes/origin/HEAD')) ? 'default-ref' : null;
    case 'rev-parse':
      return tail.some((entry) => entry.startsWith('origin/') || entry.includes('refs/remotes/origin/') || entry === '--verify') ? 'ref-resolution' : null;
    case 'cat-file': return 'ref-resolution';
    case 'show-ref': return 'ref-resolution';
    case 'worktree': return tail[0] === 'add' ? 'worktree' : null;
    case 'branch': return tail.includes('--show-current') ? 'worktree' : null;
    default: return null;
  }
}

function repairFor(kind) {
  switch (kind) {
    case 'authentication': return 'replace or reauthenticate the configured host Git credential';
    case 'authorization': return 'grant the configured host identity access to the repository and required refs';
    case 'repository-not-visible': return 'verify the canonical repository identity and that the configured host credential can see it';
    case 'origin-mismatch': return 'review the managed repository origin before allowing DevBridge to reuse local state';
    case 'worktree-collision': return 'repair or remove only the conflicting DevBridge-owned worktree or branch state, then retry';
    case 'local-corruption': return 'repair or recreate only the affected managed Git repository after preserving required recovery evidence';
    case 'timeout': return 'check host network/Git service health and retry after the transient condition is resolved';
    case 'fetch-or-ref': return 'verify the requested/default ref exists and refresh the managed repository fetch state';
    default: return 'inspect local bounded Git diagnostics and repair the affected repository admission state';
  }
}

export function classifyRepositoryAdmissionFailure(result) {
  const phase = repositoryAdmissionPhase(result?.args);
  if (!phase) return null;
  const text = textOf(result);
  let kind = 'git-failure';

  if (result?.timedOut === true) kind = 'timeout';
  else if (/authentication failed|could not read username|could not read password|terminal prompts disabled|invalid username or password|credential.*(?:failed|rejected)/iu.test(text)) kind = 'authentication';
  else if (/\b403\b|permission denied|access denied|not authorized|authorization failed|insufficient permission|write access .* not granted/iu.test(text)) kind = 'authorization';
  else if (/repository not found|repository .* does not exist|does not appear to be a git repository|\b404\b/iu.test(text)) kind = 'repository-not-visible';
  else if (/corrupt|bad object|invalid object|object file .* is empty|loose object .* is corrupt|index file corrupt|bad pack header/iu.test(text)) kind = 'local-corruption';
  else if (phase === 'origin') kind = 'origin-mismatch';
  else if (phase === 'worktree' || /already checked out at|is already checked out|worktree .* already exists|branch .* already exists/iu.test(text)) kind = 'worktree-collision';
  else if (['clone', 'fetch', 'default-ref', 'ref-resolution', 'remote-access'].includes(phase)) kind = 'fetch-or-ref';

  const repair = repairFor(kind);
  return Object.freeze({
    code: 'REPOSITORY_ADMISSION_FAILED',
    phase,
    kind,
    repair,
    retryable: kind === 'timeout',
    message: `repository admission failed during ${phase}: ${kind}; ${repair}`,
  });
}

function isLocalPath(value) {
  return WINDOWS_DRIVE_PATH.test(value) || WINDOWS_UNC_PATH.test(value) || value.startsWith('/') || value.startsWith('./') || value.startsWith('../');
}

export function sanitizeGitRemote(value) {
  let text = String(value ?? '').trim();
  if (isLocalPath(text)) return redactText(text).replace(/[\\/]$/u, '').slice(0, 2048);
  try {
    const parsed = new URL(text);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    text = parsed.toString();
  } catch {
    text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1');
  }
  return redactText(text)
    .replace(/\/$/u, '')
    .slice(0, 2048);
}

export function sanitizeGitCommandOutput(args, stdout) {
  const phase = repositoryAdmissionPhase(args);
  const command = subcommand(args);
  if (phase !== 'origin' || command?.value !== 'remote') return String(stdout ?? '');
  return String(stdout ?? '')
    .split(/\r?\n/u)
    .map((line) => line ? sanitizeGitRemote(line) : '')
    .join('\n');
}

function normalizeRepository(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(text)) throw new TypeError('repository admission identity is invalid');
  return text;
}

function authBaseUrl(remoteUrl) {
  try {
    const parsed = new URL(remoteUrl);
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

function parseRemoteHead(stdout) {
  let defaultRef = null;
  let headSha = null;
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] === 'ref:' && fields[1]?.startsWith('refs/heads/') && fields[2] === 'HEAD') defaultRef = fields[1];
    if (SHA.test(String(fields[0] ?? '').toLowerCase()) && fields[1] === 'HEAD') headSha = fields[0].toLowerCase();
  }
  return { defaultRef, headSha };
}

export async function inspectRepositoryAdmission({ repository, remoteUrl, run, token = null, timeoutMs = 60_000 } = {}) {
  const identity = normalizeRepository(repository);
  if (typeof remoteUrl !== 'string' || remoteUrl.length === 0 || remoteUrl.includes('\0')) throw new TypeError('repository admission remote is invalid');
  if (typeof run !== 'function') throw new TypeError('repository admission run contract is incomplete');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) throw new TypeError('repository admission timeout is invalid');
  const args = ['ls-remote', '--symref', '--', remoteUrl, 'HEAD'];
  const result = await run(args, {
    token,
    authBaseUrl: authBaseUrl(remoteUrl),
    timeoutMs,
    allowFailure: true,
  });
  if (result?.timedOut === true || result?.exitCode !== 0) {
    const failure = classifyRepositoryAdmissionFailure({ ...result, args });
    return Object.freeze({
      repository: identity,
      ready: false,
      code: failure?.code ?? 'REPOSITORY_ADMISSION_FAILED',
      phase: failure?.phase ?? 'remote-access',
      kind: failure?.kind ?? 'git-failure',
      repair: failure?.repair ?? repairFor('git-failure'),
      defaultRef: null,
      headSha: null,
    });
  }
  const observed = parseRemoteHead(result.stdout);
  if (!observed.headSha) {
    return Object.freeze({
      repository: identity,
      ready: false,
      code: 'REPOSITORY_ADMISSION_FAILED',
      phase: 'default-ref',
      kind: 'fetch-or-ref',
      repair: repairFor('fetch-or-ref'),
      defaultRef: observed.defaultRef,
      headSha: null,
    });
  }
  return Object.freeze({
    repository: identity,
    ready: true,
    code: null,
    phase: 'remote-access',
    kind: null,
    repair: null,
    defaultRef: observed.defaultRef,
    headSha: observed.headSha,
  });
}

export function normalizeRepositoryAdmissionSet(values) {
  if (!Array.isArray(values) || values.length > MAX_REPOSITORIES) throw new TypeError(`repository admission set must contain at most ${MAX_REPOSITORIES} repositories`);
  return Object.freeze([...new Set(values.map(normalizeRepository))]);
}
