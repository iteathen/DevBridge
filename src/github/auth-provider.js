import { spawn } from 'node:child_process';
import process from 'node:process';

export const DEFAULT_GITHUB_TOKEN_ENVIRONMENT_VARIABLES = Object.freeze([
  'PATCH_POLLER_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);

const GH_OUTPUT_LIMIT = 64 * 1024;
const GH_TIMEOUT_MS = 15_000;
const SAFE_GH_ENVIRONMENT = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
]);

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function environmentCredential(auth, env) {
  if (auth.mode === 'github-cli') return null;
  for (const name of auth.environmentVariables) {
    const value = env[name];
    if (nonempty(value)) {
      return { provider: 'environment', source: name, token: value };
    }
  }
  return null;
}

function githubCliEnvironment(source) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value != null && SAFE_GH_ENVIRONMENT.has(name.toUpperCase())) env[name] = value;
  }
  // A stored GitHub CLI credential is a distinct fallback. Prevent unrelated
  // ambient token variables from silently changing which credential gh returns.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

export function defaultGitHubCliTokenResolver({ executable, hostname, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, ['auth', 'token', '--hostname', hostname], {
        env: githubCliEnvironment(env),
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    let output = Buffer.alloc(0);
    let exceeded = false;
    child.stdout.on('data', (chunk) => {
      if (exceeded) return;
      output = Buffer.concat([output, Buffer.from(chunk)]);
      if (output.length > GH_OUTPUT_LIMIT) {
        exceeded = true;
        child.kill();
      }
    });

    const timer = setTimeout(() => child.kill(), GH_TIMEOUT_MS);
    timer.unref?.();
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) {
        resolve(null);
        return;
      }
      const token = output.toString('utf8').trim();
      resolve(nonempty(token) ? token : null);
    });
  });
}

export async function resolveGitHubCredential(
  auth,
  { env = process.env, githubCliTokenResolver = defaultGitHubCliTokenResolver } = {},
) {
  const fromEnvironment = environmentCredential(auth, env);
  if (fromEnvironment) return fromEnvironment;
  if (auth.mode === 'environment') return null;

  const token = await githubCliTokenResolver({
    executable: auth.githubCliExecutable,
    hostname: auth.hostname,
    env,
  });
  if (!nonempty(token)) return null;
  return {
    provider: 'github-cli',
    source: `github-cli:${auth.hostname}`,
    token,
  };
}

export function publicGitHubCredentialStatus(auth, credential) {
  return {
    mode: auth.mode,
    available: Boolean(credential),
    provider: credential?.provider ?? null,
    source: credential?.source ?? null,
    environmentVariables: [...auth.environmentVariables],
    githubCliExecutable: auth.githubCliExecutable,
    hostname: auth.hostname,
  };
}
