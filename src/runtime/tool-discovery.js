import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const TOOL_CATALOG = Object.freeze([
  ['mise', 'runtime-manager'], ['asdf', 'runtime-manager'],
  ['uv', 'package-manager'], ['pnpm', 'package-manager'], ['cargo', 'package-manager'], ['bun', 'package-manager'],
  ['just', 'task-runner'], ['hyperfine', 'benchmark'], ['earthly', 'task-runner'],
  ['rg', 'code-search'], ['fzf', 'code-search'], ['ast-grep', 'code-search'], ['sg', 'code-search'],
  ['fd', 'filesystem'], ['eza', 'filesystem'], ['bat', 'filesystem'], ['delta', 'diff'], ['difft', 'diff'], ['difftastic', 'diff'],
  ['git', 'vcs'], ['jj', 'vcs'], ['sl', 'vcs'], ['sapling', 'vcs'], ['gh', 'platform-cli'], ['glab', 'platform-cli'],
  ['docker', 'container'], ['podman', 'container'], ['nerdctl', 'container'], ['kubectl', 'orchestration'], ['helm', 'orchestration'],
  ['terraform', 'iac'], ['tofu', 'iac'], ['pulumi', 'iac'], ['ansible', 'iac'],
  ['curl', 'network-client'], ['xh', 'network-client'], ['http', 'network-client'], ['httpie', 'network-client'], ['slumber', 'network-client'],
  ['trivy', 'security'], ['snyk', 'security'], ['gitleaks', 'security'], ['age', 'security'], ['sops', 'security'],
  ['claude', 'coding-agent'], ['aider', 'coding-agent'], ['ollama', 'coding-agent'],
]);

export function defaultToolCatalog() {
  return TOOL_CATALOG.map(([command, category]) => ({ command, category }));
}

function pathDirectories(env, platform) {
  const raw = platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '');
  return [...new Set(String(raw).split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry)))];
}

function executableNames(command, env, platform) {
  if (platform !== 'win32') return [command];
  const extensions = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return extensions.map((extension) => `${command}${extension}`.toLowerCase());
}

async function indexDirectory(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return { directory, names: new Map(entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => [entry.name.toLowerCase(), entry.name])) };
  } catch {
    return { directory, names: new Map() };
  }
}

async function executableCandidate(command, indexes, env, platform) {
  const wanted = executableNames(command, env, platform);
  for (const index of indexes) {
    for (const candidate of wanted) {
      const actual = index.names.get(candidate.toLowerCase());
      if (!actual) continue;
      const absolute = path.join(index.directory, actual);
      if (platform === 'win32') return absolute;
      try { await access(absolute, 1); return absolute; }
      catch { /* continue */ }
    }
  }
  return null;
}

async function versionProbe(executable, { timeoutMs = 1000 } = {}) {
  const child = spawn(executable, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { PATH: process.env.PATH ?? '' } });
  let text = '';
  const append = (chunk) => { if (text.length < 4096) text += String(chunk).slice(0, 4096 - text.length); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  timer.unref?.();
  const code = await new Promise((resolve) => { child.once('error', () => resolve(null)); child.once('exit', (value) => resolve(value)); }).finally(() => clearTimeout(timer));
  const firstLine = text.replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/gu, '').split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
  return { healthy: !timedOut && code === 0, version: firstLine?.slice(0, 240) ?? null };
}

export async function discoverPathTools({ env = process.env, platform = process.platform, catalog = defaultToolCatalog(), probeVersions = false, now = () => performance.now() } = {}) {
  const started = now();
  const directories = pathDirectories(env, platform);
  const indexes = await Promise.all(directories.map(indexDirectory));
  const tools = [];
  for (const entry of catalog) {
    const executable = await executableCandidate(entry.command, indexes, env, platform);
    let version = null;
    let healthy = executable != null;
    if (executable && probeVersions) {
      const probe = await versionProbe(executable);
      version = probe.version;
      healthy = probe.healthy;
    }
    tools.push({
      name: entry.command,
      category: entry.category ?? 'other',
      available: executable != null,
      healthy,
      version,
      source: executable ? 'PATH' : null,
      executable,
    });
  }
  return {
    protocol: 'patch-poller/tool-discovery-v1',
    platform,
    tools,
    discoveryElapsedMs: Math.max(0, now() - started),
  };
}

export function choosePreferredAvailable(registry, choices) {
  const byName = new Map((registry?.tools ?? []).map((entry) => [entry.name, entry]));
  for (const name of choices) {
    const entry = byName.get(name);
    if (entry?.available && entry.healthy !== false) return name;
  }
  return null;
}
