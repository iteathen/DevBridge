import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertSupportedNode,
  managedGitEnvironment,
  migrateStage0Runtime,
  SOURCE_BRANCH,
  STAGE0_PROTOCOL,
  validateRuntimeShape,
} from '../devbridge.mjs';
import { observeRuntimeUpdate, parseBootstrapArgs } from '../src/bootstrap/secure-bootstrap.mjs';
import {
  migrateLocalConfig,
  prepareLocalConfig,
  readSetupState,
  resolveChannelRef,
  resolveBootstrapPaths,
  runDevBridgeCli,
  spawnDevBridgeDaemon,
  syncInstalledLauncher,
  writeSetupState,
} from '../src/bootstrap/transactional-bootstrap.mjs';

test('disposable launcher and testing updater select the same isolated branch', () => {
  const observed = [];
  const runner = (_executable, args) => {
    observed.push(args);
    return { status: 0, stdout: `${'a'.repeat(40)}\t${args.at(-1)}\n`, stderr: '' };
  };
  assert.equal(SOURCE_BRANCH, 'codex/temp-fast-functional');
  assert.equal(resolveChannelRef('testing', { paths: { gitHome: '/safe/home', hooks: '/safe/hooks' }, runner }), SOURCE_BRANCH);
  assert.ok(observed.some((args) => args.includes(`refs/heads/${SOURCE_BRANCH}`)));
});

test('bootstrap defaults to alpha development testing channel and headless start', () => {
  assert.deepEqual(parseBootstrapArgs([]), {
    command: 'start', channel: 'testing', home: null, config: null, update: true,
    releaseMode: 'development', releaseManifest: null, releasePublicKey: null,
  });
});

test('bootstrap accepts one safe command and local-only switches', () => {
  assert.deepEqual(parseBootstrapArgs(['run-once', '--channel', 'stable', '--home', '/tmp/db', '--no-update']), {
    command: 'run-once', channel: 'stable', home: '/tmp/db', config: null, update: false,
    releaseMode: 'development', releaseManifest: null, releasePublicKey: null,
  });
  for (const command of ['install', 'setup', 'uninstall', 'update', 'start', 'logs', 'status', 'pause', 'resume', 'stop', 'restart']) assert.equal(parseBootstrapArgs([command]).command, command);
  assert.equal(parseBootstrapArgs(['setup', '--channel', 'stable', '--prompt-channel']).channel, 'stable');
  assert.equal(parseBootstrapArgs(['setup', '--repository', 'owner/one', '--confirm', 'APPLY']).command, 'setup');
  assert.throws(() => parseBootstrapArgs(['--channel', 'evil']), /Unknown DevBridge channel/u);
  assert.throws(() => parseBootstrapArgs(['daemon', 'run-once']), /Only one/u);
  assert.throws(() => parseBootstrapArgs(['--repository', 'attacker/repo']), /require the setup command/u);
  assert.throws(() => parseBootstrapArgs(['start', '--confirm', 'APPLY']), /requires the setup or uninstall command/u);
  assert.throws(() => parseBootstrapArgs(['uninstall', '--purge', '--app-only']), /Choose|Unknown/u);
});

test('doctor update observation reports current, available, disabled, and production-policy states', () => {
  const head = 'a'.repeat(40);
  const next = 'b'.repeat(40);
  const paths = { gitHome: '/safe/home', hooks: '/safe/hooks' };
  const runtime = { head };
  const runner = (_executable, args) => ({ status: 0, stdout: `${next}\t${args.at(-1)}\n`, stderr: '' });
  assert.equal(observeRuntimeUpdate({ update: true, releaseMode: 'development', channel: 'testing' }, paths, runtime, runner).state, 'available');
  const currentRunner = (_executable, args) => ({ status: 0, stdout: `${head}\t${args.at(-1)}\n`, stderr: '' });
  assert.equal(observeRuntimeUpdate({ update: true, releaseMode: 'development', channel: 'testing' }, paths, runtime, currentRunner).state, 'current');
  assert.equal(observeRuntimeUpdate({ update: false, releaseMode: 'development', channel: 'testing' }, paths, runtime, runner).state, 'disabled');
  assert.equal(observeRuntimeUpdate({ update: true, releaseMode: 'production', channel: 'stable' }, paths, runtime, runner).state, 'release-policy');
  const unavailable = () => ({ status: 1, stdout: '', stderr: 'offline' });
  assert.equal(observeRuntimeUpdate({ update: true, releaseMode: 'development', channel: 'testing' }, paths, runtime, unavailable).state, 'unknown');
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
  writeFileSync(example, '{"safe":true,"workspace":{"root":"~/.devbridge/workspaces"},"state":{"directory":"~/.devbridge/state"}}\n');
  assert.equal(prepareLocalConfig(paths), true);
  const initialized = JSON.parse(readFileSync(paths.config, 'utf8'));
  assert.equal(initialized.safe, true);
  assert.equal(initialized.workspace.root, path.join(root, 'workspaces'));
  assert.equal(initialized.state.directory, path.join(root, 'state'));
  writeFileSync(paths.config, '{"operator":true}\n');
  writeFileSync(example, '{"safe":false}\n');
  assert.equal(prepareLocalConfig(paths), false);
  assert.equal(readFileSync(paths.config, 'utf8'), '{"operator":true}\n');
});

test('bootstrap migrates a singular repository config once and preserves an exact backup', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-config-migration-'));
  const paths = { config: path.join(root, 'config.json') };
  writeFileSync(paths.config, `${JSON.stringify({ version: 1, github: { queueRepository: 'owner/repo', taskLabel: 'ready' }, execution: { enabled: false } }, null, 2)}\n`);
  const result = migrateLocalConfig(paths);
  assert.equal(result.changed, true);
  assert.equal(existsSync(result.backup), true);
  const migrated = JSON.parse(readFileSync(paths.config, 'utf8'));
  assert.deepEqual(migrated.github.queueRepositories, ['owner/repo']);
  assert.equal(Object.hasOwn(migrated.github, 'queueRepository'), false);
  assert.equal(JSON.parse(readFileSync(result.backup, 'utf8')).github.queueRepository, 'owner/repo');
  assert.deepEqual(migrateLocalConfig(paths), { changed: false, reason: 'current' });
});

test('completed setup state locks normal launches out of implicit setup and corruption fails closed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'devbridge-setup-state-'));
  const paths = { setupStateFile: path.join(root, 'setup-state.json') };
  assert.equal(readSetupState(paths), null);
  writeFileSync(paths.setupStateFile, '{broken');
  assert.throws(() => readSetupState(paths), /explicitly run setup/u);
  writeSetupState(paths, { channel: 'testing', repositories: ['owner/repo'] });
  assert.equal(readSetupState(paths).state, 'complete');
});

test('accepted runtime refreshes only the canonical installed CLI launcher', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'devbridge-launcher-sync-'));
  const target = path.join(home, 'bin', 'devbridge.mjs');
  const runtimeDir = path.join(home, 'runtime-candidates', 'candidate');
  mkdirSync(path.dirname(target), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(target, 'old\n');
  writeFileSync(path.join(runtimeDir, 'devbridge.mjs'), 'new\n');
  assert.equal(syncInstalledLauncher({ home }, { runtimeDir }, { invokedPath: target }).changed, true);
  assert.equal(readFileSync(target, 'utf8'), 'new\n');
  writeFileSync(target, 'operator\n');
  assert.deepEqual(syncInstalledLauncher({ home }, { runtimeDir }, { invokedPath: path.join(home, 'elsewhere.mjs') }), { changed: false, reason: 'external-launcher' });
  assert.equal(readFileSync(target, 'utf8'), 'operator\n');
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.stdout || result.error?.message));
  return String(result.stdout || '').trim();
}

test('stage 0 performs only a clean fast-forward protocol transition and records rollback evidence', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'devbridge-stage0-migration-'));
  const runtime = path.join(home, 'runtime');
  mkdirSync(path.join(runtime, 'src', 'bootstrap'), { recursive: true });
  writeFileSync(path.join(runtime, 'package.json'), '{"name":"devbridge","version":"0.1.0","type":"module"}\n');
  writeFileSync(path.join(runtime, 'src', 'bootstrap', 'secure-bootstrap.mjs'), 'export async function bootstrap() { return 0; }\n');
  git(runtime, ['init']);
  git(runtime, ['config', 'user.email', 'devbridge-test@example.invalid']);
  git(runtime, ['config', 'user.name', 'DevBridge Test']);
  git(runtime, ['config', 'core.autocrlf', 'false']);
  git(runtime, ['remote', 'add', 'origin', 'https://github.com/iteathen/DevBridge.git']);
  git(runtime, ['add', '.']);
  git(runtime, ['commit', '-m', 'old protocol']);
  const previousHead = git(runtime, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(runtime, 'package.json'), `{"name":"devbridge","version":"0.1.0","type":"module","devbridge":{"stage0Protocol":${STAGE0_PROTOCOL}}}\n`);
  git(runtime, ['add', 'package.json']);
  git(runtime, ['commit', '-m', 'current protocol']);
  const candidateHead = git(runtime, ['rev-parse', 'HEAD']);
  git(runtime, ['checkout', '--detach', previousHead]);
  const paths = {
    home,
    runtime,
    config: path.join(home, 'config.json'),
    gitHome: path.join(home, 'bootstrap-git-home'),
    hooks: path.join(home, 'bootstrap-empty-hooks'),
    migrationLock: path.join(home, 'stage0-migration.lock'),
    migrationState: path.join(home, 'stage0-migration.json'),
  };
  mkdirSync(paths.gitHome, { recursive: true });
  mkdirSync(paths.hooks, { recursive: true });
  const result = migrateStage0Runtime(
    { command: 'update', noUpdate: false },
    paths,
    validateRuntimeShape(runtime),
    undefined,
    { fetchCandidateFn: () => candidateHead },
  );
  assert.equal(result.migrated, true);
  assert.equal(result.head, candidateHead);
  assert.equal(git(runtime, ['rev-parse', 'refs/devbridge/stage0-previous']), previousHead);
  assert.equal(JSON.parse(readFileSync(paths.migrationState, 'utf8')).state, 'activated');
  assert.equal(existsSync(paths.migrationLock), false);
});

test('node version gate rejects older runtimes', () => {
  assert.doesNotThrow(() => assertSupportedNode('22.16.0'));
  assert.doesNotThrow(() => assertSupportedNode('24.0.0'));
  assert.throws(() => assertSupportedNode('22.15.9'), /22\.16\.0 or newer/u);
});

test('runtime CLI launch never uses a shell or opens a Windows console', () => {
  let observed;
  const runner = (executable, args, options) => { observed = { executable, args, options }; return { status: 0 }; };
  const status = runDevBridgeCli('poll-once', { runtime: '/managed/runtime', config: '/operator/config.json' }, { cliPath: '/managed/runtime/src/cli.js' }, runner);
  assert.equal(status, 0);
  assert.equal(observed.executable, process.execPath);
  assert.deepEqual(observed.args, ['/managed/runtime/src/cli.js', 'poll-once', '--config', '/operator/config.json']);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
});

test('supervised daemon launch stays headless on Windows', () => {
  let observed;
  const child = { pid: 1234 };
  const spawnImpl = (executable, args, options) => { observed = { executable, args, options }; return child; };
  const result = spawnDevBridgeDaemon(
    { runtime: '/managed/runtime', config: '/operator/config.json' },
    { runtimeDir: '/managed/runtime', cliPath: '/managed/runtime/src/cli.js' },
    spawnImpl,
  );
  assert.equal(result, child);
  assert.equal(observed.executable, process.execPath);
  assert.deepEqual(observed.args, ['/managed/runtime/src/cli.js', 'daemon', '--config', '/operator/config.json']);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.stdio, 'inherit');
});
