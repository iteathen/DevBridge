import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';

const MAX_PATH_DIRECTORIES = 64;
const MAX_CATALOG_ENTRIES = 128;
const COMMAND_RE = /^[A-Za-z0-9_.+-]{1,80}$/u;
const CATEGORY_RE = /^[A-Za-z0-9_.-]{1,80}$/u;

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

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function defaultToolCatalog() {
  return TOOL_CATALOG.map(([command, category]) => ({ command, category }));
}

function normalizeCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length > MAX_CATALOG_ENTRIES) {
    throw new PolicyError(`tool discovery catalog must contain at most ${MAX_CATALOG_ENTRIES} entries`);
  }
  const normalized = [];
  const seen = new Set();
  for (const [index, raw] of catalog.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError(`tool discovery catalog[${index}] must be an object`);
    const command = raw.command;
    const category = raw.category ?? 'other';
    if (typeof command !== 'string' || !COMMAND_RE.test(command)) throw new PolicyError(`tool discovery catalog[${index}].command is invalid`);
    if (typeof category !== 'string' || !CATEGORY_RE.test(category)) throw new PolicyError(`tool discovery catalog[${index}].category is invalid`);
    if (seen.has(command)) continue;
    seen.add(command);
    normalized.push({ command, category });
  }
  return normalized.sort((a, b) => codepointCompare(a.command, b.command));
}

function pathDirectories(env, platform) {
  const raw = platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '');
  const unique = [];
  const seen = new Set();
  let truncated = false;
  for (const entry of String(raw).split(path.delimiter)) {
    if (!entry) continue;
    const resolved = path.resolve(entry);
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    if (unique.length >= MAX_PATH_DIRECTORIES) {
      truncated = true;
      break;
    }
    seen.add(key);
    unique.push(resolved);
  }
  return { directories: unique, truncated };
}

function executableNames(command, env, platform) {
  if (platform !== 'win32') return [command];
  const extensions = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 16);
  return extensions.map((extension) => `${command}${extension}`.toLowerCase());
}

async function indexDirectory(directory, readDirectory) {
  try {
    const entries = await readDirectory(directory, { withFileTypes: true });
    return {
      directory,
      names: new Map(entries
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => [entry.name.toLowerCase(), entry.name])),
    };
  } catch {
    return { directory, names: new Map() };
  }
}

async function executableCandidate(command, indexes, env, platform, accessFn) {
  const wanted = executableNames(command, env, platform);
  for (const index of indexes) {
    for (const candidate of wanted) {
      const actual = index.names.get(candidate.toLowerCase());
      if (!actual) continue;
      const absolute = path.join(index.directory, actual);
      if (platform === 'win32') return absolute;
      try {
        await accessFn(absolute, 1);
        return absolute;
      } catch {
        // Presence without execute permission is not an available CLI.
      }
    }
  }
  return null;
}

/**
 * Observe a bounded allowlisted catalog in PATH without executing discovered code.
 * Absolute paths are returned only to the local caller and MUST be removed by any
 * remote projection. Presence is informational; it does not register capability.
 */
export async function discoverPathTools({
  env = process.env,
  platform = process.platform,
  catalog = defaultToolCatalog(),
  readDirectory = readdir,
  accessFn = access,
  now = () => performance.now(),
} = {}) {
  const started = now();
  const normalizedCatalog = normalizeCatalog(catalog);
  const pathState = pathDirectories(env, platform);
  const indexes = await Promise.all(pathState.directories.map((directory) => indexDirectory(directory, readDirectory)));
  const tools = [];
  for (const entry of normalizedCatalog) {
    const executable = await executableCandidate(entry.command, indexes, env, platform, accessFn);
    tools.push({
      name: entry.command,
      category: entry.category,
      available: executable != null,
      observed: executable != null ? 'path-presence' : 'absent',
      executable,
      executableAuthority: false,
      probeStatus: 'not-executed',
    });
  }
  return {
    protocol: 'devbridge/tool-discovery-v1',
    platform,
    tools,
    directoriesScanned: indexes.length,
    pathTruncated: pathState.truncated,
    discoveryElapsedMs: Math.max(0, now() - started),
  };
}

/** Planning helper only. Returning a name does not authorize execution. */
export function choosePreferredAvailable(discovery, choices) {
  const byName = new Map((discovery?.tools ?? []).map((entry) => [entry.name, entry]));
  for (const name of choices ?? []) {
    const entry = byName.get(name);
    if (entry?.available === true) return name;
  }
  return null;
}
