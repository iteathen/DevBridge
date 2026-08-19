#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const historical = new Set([
  'docs/testing/PP-DURABILITY-AUDIT-0818.md',
]);

function relPath(value) {
  return value.split(path.sep).join('/');
}

function isHistorical(relative) {
  return relative.startsWith('docs/handoffs/') || historical.has(relative);
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, files);
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function remove(relative) {
  const target = path.join(root, relative);
  if (existsSync(target)) rmSync(target, { force: true });
}

function rename(relativeFrom, relativeTo) {
  const from = path.join(root, relativeFrom);
  const to = path.join(root, relativeTo);
  if (!existsSync(from)) throw new Error(`missing rename source: ${relativeFrom}`);
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
}

for (const entry of readdirSync(path.join(root, 'specs'))) {
  const match = /^PP-(\d{3})-(.+)$/u.exec(entry);
  if (!match) continue;
  rename(`specs/${entry}`, `specs/DB-${match[1]}-${match[2]}`);
}
rename('src/bootstrap/legacy-bootstrap.mjs', 'src/bootstrap/runtime-bootstrap.mjs');
remove('patch-poller.mjs');
remove('config/patch-poller.example.json');
remove('docs/naming-and-compatibility.md');
remove('test/legacy-takeover.test.js');

function transformText(input) {
  return input
    .replaceAll('PATCH-POLLER-RESUME-GITHUB', 'DEVBRIDGE-RESUME-GITHUB')
    .replaceAll('PATCH-POLLER-RESUME', 'DEVBRIDGE-RESUME')
    .replaceAll('PATCH_POLLER_', 'DEVBRIDGE_')
    .replaceAll('PATCH_POLLER', 'DEVBRIDGE')
    .replaceAll('patch_poller', 'devbridge')
    .replaceAll('patchpoller', 'devbridge')
    .replaceAll('PATCH-POLLER', 'DevBridge')
    .replaceAll('PatchPoller', 'DevBridge')
    .replaceAll('patch-poller', 'devbridge')
    .replace(/\bPP-(00[1-9]|01[0-8])\b/gu, 'DB-$1')
    .replaceAll('runPollerCliCaptured', 'runDevBridgeCliCaptured')
    .replaceAll('runPollerCli', 'runDevBridgeCli')
    .replaceAll('spawnPollerDaemon', 'spawnDevBridgeDaemon');
}

for (const absolute of walk(root)) {
  const relative = relPath(path.relative(root, absolute));
  if (isHistorical(relative) || relative === 'scripts/devbridge-hard-cutover.mjs') continue;
  const extension = path.extname(relative).toLowerCase();
  if (!['.js', '.mjs', '.md', '.json', '.yml', '.yaml', '.gitignore'].includes(extension) && path.basename(relative) !== '.gitignore') continue;
  const original = readFileSync(absolute, 'utf8');
  const changed = transformText(original);
  if (changed !== original) writeFileSync(absolute, changed, 'utf8');
}

const packagePath = path.join(root, 'package.json');
const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
manifest.name = 'devbridge';
manifest.description = 'DevBridge: safely connect remote coding controllers to a locally controlled development environment.';
manifest.bin = { devbridge: './src/cli.js' };
writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const stage0 = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SOURCE_REPOSITORY = 'https://github.com/iteathen/DevBridge.git';
const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const SCRUBBED_GIT_ENVIRONMENT = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ASKPASS', 'GIT_CONFIG', 'GIT_CONFIG_COUNT',
  'GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_WORK_TREE',
  'SSH_ASKPASS', 'SSH_AUTH_SOCK',
]);

function fail(message) { throw new Error(message); }

export function assertSupportedNode(version = process.versions.node) {
  const parts = String(version).split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length < 3 || parts.some((value) => !Number.isInteger(value))) fail(\`Could not parse Node.js version: \${version}\`);
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return;
    if (parts[index] < MINIMUM_NODE[index]) fail('DevBridge requires Node.js 22.16.0 or newer.');
  }
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(\`\${flag} requires a value\`);
  return value;
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\\\')) return path.join(homedir(), value.slice(2));
  return value;
}

export function parseStage0Args(argv) {
  let home = null;
  let noUpdate = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--home') {
      if (home !== null) fail('Only one --home value may be supplied.');
      home = takeValue(argv, index, value);
      index += 1;
    } else if (value === '--no-update') {
      noUpdate = true;
    }
  }
  return { home, noUpdate };
}

export function resolveStage0Paths(args, environment = process.env) {
  const configuredHome = args.home ?? environment.DEVBRIDGE_HOME;
  const home = path.resolve(expandHome(configuredHome || path.join(homedir(), '.devbridge')));
  return {
    home,
    runtime: path.join(home, 'runtime'),
    gitHome: path.join(home, 'bootstrap-git-home'),
    hooks: path.join(home, 'bootstrap-empty-hooks'),
  };
}

export function managedGitEnvironment(paths, base = process.env, platform = process.platform) {
  const environment = { ...base };
  for (const name of SCRUBBED_GIT_ENVIRONMENT) delete environment[name];
  if (platform === 'win32') {
    const pathValue = base.Path ?? base.PATH ?? base.path;
    for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
    if (pathValue != null) environment.Path = pathValue;
  }
  environment.HOME = paths.gitHome;
  environment.USERPROFILE = paths.gitHome;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GCM_INTERACTIVE = 'Never';
  return environment;
}

function gitPrefix(paths) {
  return ['-c', \`core.hooksPath=\${paths.hooks}\`, '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never'];
}

function defaultRunner(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    shell: false,
    encoding: 'utf8',
    maxBuffer: CAPTURE_LIMIT,
  });
}

function formatFailure(executable, args, result) {
  const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
  return \`\${executable} \${args.join(' ')} failed (exit \${result.status ?? 'spawn-error'})\${detail ? \`: \${detail.slice(0, 2000)}\` : ''}\`;
}

export function runGit(args, { paths, cwd = undefined, runner = defaultRunner, allowFailure = false } = {}) {
  const fullArgs = [...gitPrefix(paths), ...args];
  const result = runner('git', fullArgs, {
    cwd,
    env: managedGitEnvironment(paths),
    timeout: GIT_TIMEOUT_MS,
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return result;
    fail(formatFailure('git', fullArgs, result));
  }
  return result;
}

function normalizedRemote(value) {
  return String(value || '').trim().replace(/\\/$/u, '').replace(/\\.git$/u, '').toLowerCase();
}

function validateRuntimeRepository(paths, runner) {
  const gitDirectory = path.join(paths.runtime, '.git');
  if (!existsSync(gitDirectory)) fail(\`Managed runtime is not a Git checkout: \${paths.runtime}\`);
  const remote = runGit(['remote', 'get-url', 'origin'], { paths, cwd: paths.runtime, runner }).stdout;
  if (normalizedRemote(remote) !== normalizedRemote(SOURCE_REPOSITORY)) fail('Managed runtime origin does not match the trusted DevBridge repository.');
  const dirty = runGit(['status', '--porcelain'], { paths, cwd: paths.runtime, runner }).stdout.trim();
  if (dirty) fail('Managed DevBridge runtime contains local changes; refusing to execute it.');
}

function validateRuntimeShape(runtime) {
  const packagePath = path.join(runtime, 'package.json');
  const secureBootstrapPath = path.join(runtime, 'src', 'bootstrap', 'secure-bootstrap.mjs');
  if (!existsSync(packagePath) || !statSync(packagePath).isFile() || !existsSync(secureBootstrapPath) || !statSync(secureBootstrapPath).isFile()) {
    fail('Fetched DevBridge runtime does not contain the expected package/bootstrap shape.');
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(packagePath, 'utf8')); }
  catch { fail('Fetched DevBridge package.json is not valid JSON.'); }
  if (manifest?.name !== 'devbridge' || typeof manifest.version !== 'string') fail('Fetched runtime does not identify itself as DevBridge.');
  return { secureBootstrapPath, version: manifest.version };
}

export function ensureStage0Runtime(args, paths, runner = defaultRunner) {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.gitHome, { recursive: true });
  mkdirSync(paths.hooks, { recursive: true });
  if (!existsSync(paths.runtime)) {
    if (args.noUpdate) fail('--no-update requires an existing managed DevBridge runtime.');
    runGit(['clone', '--no-tags', '--depth', '1', '--single-branch', '--branch', 'main', SOURCE_REPOSITORY, paths.runtime], { paths, runner });
  }
  validateRuntimeRepository(paths, runner);
  return validateRuntimeShape(paths.runtime);
}

export async function bootstrapStage0(argv = process.argv.slice(2), runner = defaultRunner) {
  assertSupportedNode();
  const args = parseStage0Args(argv);
  const paths = resolveStage0Paths(args);
  const runtime = ensureStage0Runtime(args, paths, runner);
  const module = await import(pathToFileURL(runtime.secureBootstrapPath).href);
  if (typeof module.bootstrap !== 'function') fail('Managed DevBridge runtime does not export the secure bootstrap entrypoint.');
  return module.bootstrap(argv);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  bootstrapStage0().then((status) => { process.exitCode = status; }).catch((error) => {
    process.stderr.write(\`[devbridge-stage0] \${error.message}\\n\`);
    process.exitCode = 1;
  });
}
`;
writeFileSync(path.join(root, 'devbridge.mjs'), stage0, { encoding: 'utf8', mode: 0o755 });

const runtimeCorePath = path.join(root, 'src', 'bootstrap', 'runtime-bootstrap.mjs');
let runtimeCore = transformText(readFileSync(runtimeCorePath, 'utf8'));
runtimeCore = runtimeCore
  .replace("const CHANNELS = Object.freeze({\n  testing: Object.freeze(['sol/foundation-bootstrap', 'main']),\n  stable: Object.freeze(['main']),\n});", "const CHANNELS = Object.freeze({\n  testing: Object.freeze(['main']),\n  stable: Object.freeze(['main']),\n});")
  .replace("const LEGACY_TAKEOVER_GRACE_ATTEMPTS = 2;\n", '')
  .replace("const LEGACY_LOCK_PROTOCOL = 'devbridge/daemon-lock-v1';\n", '');
const obsoleteStart = runtimeCore.indexOf('function daemonStateDirectory(');
const daemonSpawn = runtimeCore.indexOf('export function spawnDevBridgeDaemon', obsoleteStart);
if (obsoleteStart < 0 || daemonSpawn < 0) throw new Error('could not locate obsolete daemon takeover block');
runtimeCore = runtimeCore.slice(0, obsoleteStart) + runtimeCore.slice(daemonSpawn);
const oldTail = runtimeCore.indexOf('function childExit(child)');
if (oldTail < 0) throw new Error('could not locate obsolete runtime bootstrap supervisor tail');
runtimeCore = runtimeCore.slice(0, oldTail) + `function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }\n\nexport function decideSupervisorAction({ childExitCode, updatePending, operatorStopPending = false }) {\n  if (operatorStopPending) return 'stop';\n  if (updatePending) return 'update';\n  if (childExitCode === 0) return 'stop';\n  return 'restart';\n}\n\nexport async function stopExistingDaemon(paths, runtime, runner = defaultRunner, {\n  maxGraceAttempts = 2,\n  stopCommandFn = () => runDevBridgeCliCaptured('stop', paths, runtime, runner),\n  delayFn = delay,\n} = {}) {\n  for (let attempt = 1; attempt <= maxGraceAttempts; attempt += 1) {\n    const result = stopCommandFn();\n    if (result.status === 0) return { stopped: true };\n    if (result.status !== 3) {\n      const detail = (result.stderr || result.stdout).trim();\n      fail(\`Could not stop existing DevBridge daemon (exit \${result.status})\${detail ? \`: \${detail.slice(0, 2000)}\` : ''}\`);\n    }\n    if (attempt < maxGraceAttempts) {\n      process.stdout.write(\`[devbridge-supervisor] existing daemon is finishing an active cycle; cooperative stop attempt \${attempt}/\${maxGraceAttempts}\\n\`);\n      await delayFn(1000);\n    }\n  }\n  fail('Existing DevBridge daemon did not stop at the cooperative boundary; refusing to terminate an unverified process.');\n}\n`;
writeFileSync(runtimeCorePath, runtimeCore, 'utf8');

const transactionalPath = path.join(root, 'src', 'bootstrap', 'transactional-bootstrap.mjs');
let transactional = transformText(readFileSync(transactionalPath, 'utf8'))
  .replace("import * as legacy from './legacy-bootstrap.mjs';", "import * as runtimeCore from './runtime-bootstrap.mjs';")
  .replace("export * from './legacy-bootstrap.mjs';", "export * from './runtime-bootstrap.mjs';")
  .replaceAll('legacy.', 'runtimeCore.')
  .replace(/\btakeover\b/gu, 'stopExisting');
transactional = transactional.replace(
  /export async function stopExistingDaemon\(paths, runtime, runner = defaultRunner, options = \{\}\) \{[\s\S]*?\n\}/u,
  `export async function stopExistingDaemon(paths, runtime, runner = defaultRunner, options = {}) {\n  return runtimeCore.stopExistingDaemon(paths, runtime, runner, {\n    ...options,\n    stopCommandFn: options.stopCommandFn ?? (() => runDevBridgeCliCaptured('stop', paths, runtime, runner)),\n  });\n}`,
);
writeFileSync(transactionalPath, transactional, 'utf8');

const securePath = path.join(root, 'src', 'bootstrap', 'secure-bootstrap.mjs');
let secure = transformText(readFileSync(securePath, 'utf8')).replace(/\btakeover\b/gu, 'stopExisting');
writeFileSync(securePath, secure, 'utf8');

const bootstrapTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertSupportedNode, managedGitEnvironment } from '../devbridge.mjs';
import { parseBootstrapArgs } from '../src/bootstrap/secure-bootstrap.mjs';
import {
  prepareLocalConfig,
  resolveBootstrapPaths,
  runDevBridgeCli,
} from '../src/bootstrap/transactional-bootstrap.mjs';

test('bootstrap defaults to alpha development testing channel and daemon', () => {
  assert.deepEqual(parseBootstrapArgs([]), {
    command: 'daemon', channel: 'testing', home: null, config: null, update: true,
    releaseMode: 'development', releaseManifest: null, releasePublicKey: null,
  });
});

test('bootstrap accepts one safe command and local-only switches', () => {
  assert.deepEqual(parseBootstrapArgs(['run-once', '--channel', 'stable', '--home', '/tmp/db', '--no-update']), {
    command: 'run-once', channel: 'stable', home: '/tmp/db', config: null, update: false,
    releaseMode: 'development', releaseManifest: null, releasePublicKey: null,
  });
  for (const command of ['status', 'stop', 'restart']) assert.equal(parseBootstrapArgs([command]).command, command);
  assert.throws(() => parseBootstrapArgs(['--channel', 'evil']), /Unknown DevBridge channel/u);
  assert.throws(() => parseBootstrapArgs(['daemon', 'run-once']), /Only one/u);
  assert.throws(() => parseBootstrapArgs(['--repository', 'attacker/repo']), /Unknown bootstrap argument/u);
});

test('production mode is explicit, stable-only, and requires local signed-release inputs', () => {
  const parsed = parseBootstrapArgs(['--channel', 'stable', '--release-mode', 'production', '--release-manifest', './release.json', '--release-public-key', './release.pub.pem']);
  assert.equal(parsed.releaseMode, 'production');
  assert.equal(parsed.channel, 'stable');
  assert.equal(parsed.releaseManifest, path.resolve('./release.json'));
  assert.equal(parsed.releasePublicKey, path.resolve('./release.pub.pem'));
  assert.throws(() => parseBootstrapArgs(['--release-mode', 'production']), /requires --channel stable/u);
  assert.throws(() => parseBootstrapArgs(['--channel', 'stable', '--release-mode', 'production']), /requires --release-manifest/u);
  assert.throws(() => parseBootstrapArgs(['--release-mode', 'development', '--release-manifest', './release.json']), /valid only with --release-mode production/u);
});

test('managed Git environment removes inherited Git and SSH authority and normalizes Windows PATH', () => {
  const paths = { gitHome: '/safe/home' };
  const env = managedGitEnvironment(paths, { PATH: '/bin', GIT_DIR: '/attacker/gitdir', GIT_CONFIG_COUNT: '1', GIT_SSH_COMMAND: 'evil', SSH_AUTH_SOCK: '/secret/agent' }, 'linux');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/safe/home');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'Never');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  const windows = managedGitEnvironment(paths, { PATH: 'wrong', Path: 'right' }, 'win32');
  assert.equal(windows.Path, 'right');
  assert.equal(windows.PATH, undefined);
});

test('first run creates canonical DevBridge config outside the managed runtime without overwriting it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-bootstrap-'));
  const args = parseBootstrapArgs(['--home', root]);
  const paths = resolveBootstrapPaths(args, {});
  mkdirSync(path.join(paths.runtime, 'config'), { recursive: true });
  const example = path.join(paths.runtime, 'config', 'devbridge.example.json');
  writeFileSync(example, '{"safe":true}\\n');
  assert.equal(prepareLocalConfig(paths), true);
  assert.equal(readFileSync(paths.config, 'utf8'), '{"safe":true}\\n');
  writeFileSync(paths.config, '{"operator":true}\\n');
  writeFileSync(example, '{"safe":false}\\n');
  assert.equal(prepareLocalConfig(paths), false);
  assert.equal(readFileSync(paths.config, 'utf8'), '{"operator":true}\\n');
});

test('node version gate rejects older runtimes', () => {
  assert.doesNotThrow(() => assertSupportedNode('22.16.0'));
  assert.doesNotThrow(() => assertSupportedNode('24.0.0'));
  assert.throws(() => assertSupportedNode('22.15.9'), /22\\.16\\.0 or newer/u);
});

test('runtime CLI launch never uses a shell', () => {
  let observed;
  const runner = (executable, args, options) => { observed = { executable, args, options }; return { status: 0 }; };
  const status = runDevBridgeCli('poll-once', { runtime: '/managed/runtime', config: '/operator/config.json' }, { cliPath: '/managed/runtime/src/cli.js' }, runner);
  assert.equal(status, 0);
  assert.equal(observed.executable, process.execPath);
  assert.deepEqual(observed.args, ['/managed/runtime/src/cli.js', 'poll-once', '--config', '/operator/config.json']);
  assert.equal(observed.options.shell, false);
});
`;
writeFileSync(path.join(root, 'test', 'bootstrap.test.js'), bootstrapTest, 'utf8');

const standaloneTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.stdout || result.error?.message));
}

test('standalone launcher reaches managed bootstrap with no adjacent src tree', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-stage0-'));
  const downloadDir = path.join(root, 'download');
  const home = path.join(root, 'home');
  const runtime = path.join(home, 'runtime');
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(path.join(runtime, 'src', 'bootstrap'), { recursive: true });
  const launcher = path.join(downloadDir, 'devbridge.mjs');
  copyFileSync(new URL('../devbridge.mjs', import.meta.url), launcher);
  writeFileSync(path.join(runtime, 'package.json'), '{"name":"devbridge","version":"0.1.0","type":"module"}\\n');
  writeFileSync(path.join(runtime, 'src', 'bootstrap', 'secure-bootstrap.mjs'), ` + "`" + `import { writeFileSync } from 'node:fs'; export async function bootstrap(argv) { writeFileSync(new URL('../../../stage0-marker.json', import.meta.url), JSON.stringify(argv)); return 0; }` + "`" + `);
  git(['init'], runtime);
  git(['config', 'user.email', 'devbridge-test@example.invalid'], runtime);
  git(['config', 'user.name', 'DevBridge Test'], runtime);
  git(['remote', 'add', 'origin', 'https://github.com/iteathen/DevBridge.git'], runtime);
  git(['add', '.'], runtime);
  git(['commit', '-m', 'fixture'], runtime);
  const result = spawnSync(process.execPath, [launcher, 'doctor', '--home', home, '--no-update'], { cwd: downloadDir, encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  assert.equal(path.join(downloadDir, 'src') === path.join(runtime, 'src'), false);
  const args = JSON.parse(readFileSync(path.join(home, 'stage0-marker.json'), 'utf8'));
  assert.deepEqual(args, ['doctor', '--home', home, '--no-update']);
});
`;
writeFileSync(path.join(root, 'test', 'standalone-launcher.test.js'), standaloneTest, 'utf8');

let supervisorTest = transformText(readFileSync(path.join(root, 'test', 'supervisor.test.js'), 'utf8'))
  .replace("from '../devbridge.mjs';", "from '../src/bootstrap/transactional-bootstrap.mjs';")
  .replaceAll("'sol/foundation-bootstrap'", "'main'")
  .replace(/\btakeover\b/gu, 'stopExisting');
writeFileSync(path.join(root, 'test', 'supervisor.test.js'), supervisorTest, 'utf8');

const identityTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/u, '$1'));
const ignored = new Set(['docs/testing/PP-DURABILITY-AUDIT-0818.md']);
const violations = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (relative === 'docs/handoffs') continue;
      walk(absolute);
      continue;
    }
    if (!entry.isFile() || ignored.has(relative)) continue;
    if (!/\\.(?:js|mjs|md|json|ya?ml)$/u.test(relative) && path.basename(relative) !== '.gitignore') continue;
    const text = readFileSync(absolute, 'utf8');
    const patterns = [
      /patch[-_ ]?poller/iu,
      /patchpoller/iu,
      /\\bPP-(?:00[1-9]|01[0-8])\\b/u,
      /PATCH_POLLER_/u,
    ];
    for (const pattern of patterns) if (pattern.test(text)) violations.push(\`\${relative}: \${pattern}\`);
  }
}

test('live repository identity is DevBridge-only', () => {
  walk(root);
  for (const forbidden of ['patch-poller.mjs', 'config/patch-poller.example.json', 'docs/naming-and-compatibility.md', 'src/bootstrap/legacy-bootstrap.mjs', 'test/legacy-takeover.test.js']) {
    if (existsSync(path.join(root, forbidden))) violations.push(\`forbidden live path: \${forbidden}\`);
  }
  const specNames = readdirSync(path.join(root, 'specs')).filter((name) => name.endsWith('.md'));
  assert.equal(specNames.length, 18);
  assert.ok(specNames.every((name) => /^DB-(?:00[1-9]|01[0-8])-/u.test(name)), specNames.join(', '));
  assert.deepEqual(violations, []);
});
`;
writeFileSync(path.join(root, 'test', 'product-identity.test.js'), identityTest, 'utf8');

remove('scripts/devbridge-hard-cutover.mjs');
