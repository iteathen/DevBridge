import { spawn } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path, { delimiter } from 'node:path';
import process from 'node:process';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

export const DISCOVERY_CATALOG = Object.freeze([
  ['mise', 'runtime-manager'], ['asdf', 'runtime-manager'],
  ['uv', 'package-manager'], ['pip', 'package-manager'], ['pnpm', 'package-manager'], ['npm', 'package-manager'], ['cargo', 'package-manager'], ['bun', 'package-manager'],
  ['just', 'task-runner'], ['hyperfine', 'benchmark'], ['earthly', 'task-runner'],
  ['rg', 'search'], ['grep', 'search'], ['fzf', 'search'], ['ast-grep', 'code-intelligence'], ['sg', 'code-intelligence'],
  ['fd', 'filesystem'], ['eza', 'filesystem'], ['bat', 'filesystem'], ['delta', 'diff'], ['difft', 'diff'], ['difftastic', 'diff'],
  ['git', 'vcs'], ['jj', 'vcs'], ['sl', 'vcs'], ['sapling', 'vcs'], ['gh', 'platform-cli'], ['glab', 'platform-cli'],
  ['docker', 'container'], ['podman', 'container'], ['nerdctl', 'container'], ['kubectl', 'orchestration'], ['helm', 'orchestration'],
  ['terraform', 'iac'], ['tofu', 'iac'], ['pulumi', 'iac'], ['ansible', 'iac'],
  ['curl', 'http'], ['xh', 'http'], ['http', 'http'], ['httpie', 'http'], ['slumber', 'http'],
  ['trivy', 'security'], ['snyk', 'security'], ['gitleaks', 'security'], ['age', 'security'], ['sops', 'security'],
  ['claude', 'agent'], ['aider', 'agent'], ['ollama', 'agent'],
]);

const CATALOG_BY_BINARY = new Map(DISCOVERY_CATALOG);
const MAX_PATH_DIRECTORIES = 96;
const DEFAULT_DISCOVERY_BUDGET_MS = 45;
const VERSION_LIMIT_BYTES = 16 * 1024;
const VERSION_TIMEOUT_MS = 2_000;

function nowMs() { return performance.now(); }
function canonicalBinary(value, platform) { return platform === 'win32' ? value.toLowerCase() : value; }
function executableExtensions(env, platform) {
  if (platform !== 'win32') return [''];
  return (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((value) => value.toLowerCase());
}

function logicalNameForFile(filename, platform, extensions) {
  let candidate = platform === 'win32' ? filename.toLowerCase() : filename;
  if (platform === 'win32') {
    const ext = path.extname(candidate).toLowerCase();
    if (!extensions.includes(ext)) return null;
    candidate = candidate.slice(0, -ext.length);
  }
  if (CATALOG_BY_BINARY.has(candidate)) return candidate;
  return null;
}

function versionText(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.trim().replace(/\s+/g, ' ');
  return text.length <= 300 ? text : text.slice(0, 300);
}

async function captureVersion(executable, { env = process.env, timeoutMs = VERSION_TIMEOUT_MS } = {}) {
  const child = spawn(executable, ['--version'], containedSpawnOptions({
    cwd: process.cwd(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: env.PATH ?? env.Path ?? '',
      PATHEXT: env.PATHEXT ?? '',
      SYSTEMROOT: env.SYSTEMROOT ?? '',
      WINDIR: env.WINDIR ?? '',
      HOME: '',
      USERPROFILE: '',
      GIT_TERMINAL_PROMPT: '0',
      PATCH_POLLER_NONINTERACTIVE: '1',
      NO_COLOR: '1',
    },
  }));
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  const append = (current, chunk) => {
    const next = Buffer.concat([current, Buffer.from(chunk)]);
    return next.length <= VERSION_LIMIT_BYTES ? next : next.subarray(0, VERSION_LIMIT_BYTES);
  };
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
  let timedOut = false;
  let termination = null;
  const timer = setTimeout(() => { timedOut = true; termination = terminateProcessTree(child); }, timeoutMs);
  timer.unref?.();
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(async () => {
    clearTimeout(timer);
    if (termination) await termination;
  });
  return {
    ok: exit.code === 0 && !timedOut,
    exitCode: exit.code,
    timedOut,
    version: versionText(stdout.toString('utf8'), stderr.toString('utf8')) || null,
  };
}

export class ToolDiscoveryService {
  #env;
  #platform;
  #clock;
  #budgetMs;
  #registry = null;

  constructor({ env = process.env, platform = process.platform, clock = nowMs, discoveryBudgetMs = DEFAULT_DISCOVERY_BUDGET_MS } = {}) {
    this.#env = env;
    this.#platform = platform;
    this.#clock = clock;
    this.#budgetMs = discoveryBudgetMs;
  }

  get registry() { return this.#registry ? structuredClone(this.#registry) : null; }

  async discover() {
    const started = this.#clock();
    const searchPath = this.#env.PATH ?? this.#env.Path ?? this.#env.path ?? '';
    const extensions = executableExtensions(this.#env, this.#platform);
    const directories = [...new Set(searchPath.split(delimiter).filter(Boolean).map((entry) => path.resolve(entry)))].slice(0, MAX_PATH_DIRECTORIES);
    const found = new Map();
    let complete = true;

    const scans = directories.map(async (directory, index) => {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return { directory, index, entries };
      } catch {
        return { directory, index, entries: [] };
      }
    });

    const deadline = new Promise((resolve) => {
      const remaining = Math.max(0, this.#budgetMs - (this.#clock() - started));
      const timer = setTimeout(() => resolve(null), remaining);
      timer.unref?.();
    });
    const scanned = await Promise.race([Promise.all(scans), deadline]);
    if (scanned == null) complete = false;

    for (const scan of scanned ?? []) {
      if (this.#clock() - started > this.#budgetMs) { complete = false; break; }
      for (const entry of scan.entries) {
        const logical = logicalNameForFile(entry.name, this.#platform, extensions);
        if (!logical || found.has(logical)) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const candidate = path.join(scan.directory, entry.name);
        try {
          const resolved = await realpath(candidate);
          const info = await lstat(resolved);
          if (!info.isFile()) continue;
          found.set(logical, {
            name: logical,
            category: CATALOG_BY_BINARY.get(logical),
            available: true,
            executable: resolved,
            source: 'PATH-scan',
            identity: {
              size: info.size,
              mtimeMs: Math.trunc(info.mtimeMs),
              mode: info.mode,
            },
            version: null,
            health: 'unverified',
            lastProbeAt: null,
          });
        } catch {
          // A disappearing or non-regular candidate is simply not available.
        }
      }
    }

    const entries = DISCOVERY_CATALOG.map(([name, category]) => found.get(name) ?? {
      name,
      category,
      available: false,
      executable: null,
      source: 'PATH-scan',
      identity: null,
      version: null,
      health: 'unavailable',
      lastProbeAt: null,
    });
    const finished = this.#clock();
    this.#registry = {
      protocol: 'patch-poller/tool-registry-v1',
      generatedAt: new Date().toISOString(),
      platform: this.#platform,
      elapsedMs: Math.max(0, finished - started),
      budgetMs: this.#budgetMs,
      complete,
      entries,
    };
    return this.registry;
  }

  async probeVersions({ names = null, concurrency = 4 } = {}) {
    if (!this.#registry) await this.discover();
    const selected = new Set(names ?? this.#registry.entries.filter((entry) => entry.available).map((entry) => entry.name));
    const queue = this.#registry.entries.filter((entry) => entry.available && selected.has(entry.name));
    const workers = Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, async () => {
      while (queue.length) {
        const entry = queue.shift();
        try {
          const probe = await captureVersion(entry.executable, { env: this.#env });
          entry.version = probe.version;
          entry.health = probe.ok ? 'healthy' : 'broken';
          entry.probeExitCode = probe.exitCode;
          entry.probeTimedOut = probe.timedOut;
        } catch {
          entry.health = 'broken';
          entry.version = null;
        }
        entry.lastProbeAt = new Date().toISOString();
      }
    });
    await Promise.all(workers);
    this.#registry.generatedAt = new Date().toISOString();
    return this.registry;
  }

  choose(preferences, { requireHealthy = false } = {}) {
    if (!this.#registry) return null;
    for (const name of preferences) {
      const entry = this.#registry.entries.find((candidate) => candidate.name === name);
      if (!entry?.available) continue;
      if (requireHealthy && entry.health !== 'healthy') continue;
      if (entry.health === 'broken') continue;
      return structuredClone(entry);
    }
    return null;
  }

  chooseCapability(capability) {
    const routes = {
      'python-packages': ['uv', 'pip'],
      'node-packages': ['pnpm', 'npm'],
      'code-search': ['rg', 'grep'],
      'ast-search': ['ast-grep', 'sg', 'rg'],
      'vcs': ['git', 'jj', 'sl', 'sapling'],
      'containers': ['podman', 'docker', 'nerdctl'],
      'http': ['xh', 'http', 'curl'],
    };
    return this.choose(routes[capability] ?? []);
  }
}

export function sanitizeDiscoveredRegistry(registry) {
  if (!registry) return null;
  return {
    protocol: registry.protocol,
    platform: registry.platform,
    elapsedMs: registry.elapsedMs,
    budgetMs: registry.budgetMs,
    complete: registry.complete,
    entries: registry.entries.map((entry) => ({
      name: entry.name,
      category: entry.category,
      available: entry.available,
      source: entry.source,
      version: entry.version,
      health: entry.health,
      lastProbeAt: entry.lastProbeAt,
    })),
  };
}
