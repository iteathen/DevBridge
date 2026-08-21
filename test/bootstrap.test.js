import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  STAGE0_PROTOCOL,
  assertSupportedNode,
  bootstrapStage0,
  managedGitEnvironment,
  parseStage0Args,
  reconcileStage0Migration,
  resolveStage0Paths,
  selectStage0Runtime,
  stage0InstallationTag,
} from '../devbridge.mjs';
import { parseBootstrapArgs } from '../src/bootstrap/secure-bootstrap.mjs';
import {
  prepareLocalConfig,
  resolveBootstrapPaths as resolveManagedBootstrapPaths,
  runDevBridgeCli,
} from '../src/bootstrap/transactional-bootstrap.mjs';

function writeRuntime(directory, head, minimumStage0Protocol = 0) {
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  mkdirSync(path.join(directory, 'src', 'bootstrap'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({
    name: 'devbridge',
    version: '0.1.0',
    ...(minimumStage0Protocol > 0 ? { devbridge: { bootstrap: { minimumStage0Protocol } } } : {}),
  })}\n`);
  writeFileSync(path.join(directory, 'src', 'bootstrap', 'secure-bootstrap.mjs'), 'export async function bootstrap() { return 0; }\n');
  if (minimumStage0Protocol > 0) {
    writeFileSync(path.join(directory, 'src', 'bootstrap', 'compatibility-activation.mjs'), 'export async function activateMigratedRuntime() { return 0; }\n');
  }
  writeFileSync(path.join(directory, '.fake-head'), `${head}\n`);
}

function fakeGitRunner({ remoteHead = null, onClone = null } = {}) {
  return (_executable, args, options = {}) => {
    if (args.includes('remote') && args.includes('get-url')) {
      return { status: 0, stdout: 'https://github.com/iteathen/DevBridge.git\n', stderr: '' };
    }
    if (args.includes('status') && args.includes('--porcelain')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('rev-parse') && args.includes('HEAD')) {
      return { status: 0, stdout: readFileSync(path.join(options.cwd, '.fake-head'), 'utf8'), stderr: '' };
    }
    if (args.includes('ls-remote')) {
      if (!remoteHead) return { status: 2, stdout: '', stderr: 'missing remote head' };
      return { status: 0, stdout: `${remoteHead}\trefs/heads/main\n`, stderr: '' };
    }
    if (args.includes('clone')) {
      const destination = args.at(-1);
      if (!onClone) return { status: 2, stdout: '', stderr: 'unexpected clone' };
      onClone(destination);
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected fake git invocation: ${args.join(' ')}`);
  };
}

function stage0Paths(home) {
  return resolveStage0Paths({ home }, {});
}

function activationRecord(state, runtimeDir, head) {
  return {
    protocol: 'devbridge/runtime-activation-v1',
    state,
    current: { runtimeDir, head },
  };
}

function migrationRecord(previousHead, nextHead, pid = 999999) {
  return {
    protocol: 'devbridge/stage0-migration-v1',
    state: 'transitioning',
    pid,
    previousHead,
    nextHead,
    startedAt: new Date().toISOString(),
  };
}

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

test('stage0 parses only its local migration authority and skips runtime flag values', () => {
  const oldHead = '1'.repeat(40);
  const nextHead = '2'.repeat(40);
  assert.deepEqual(parseStage0Args([
    'migrate-legacy-runtime', '--home', '/tmp/db', '--config', '/tmp/config.json',
    '--expected-runtime-head', oldHead, '--validated-candidate-head', nextHead,
  ]), {
    home: '/tmp/db', noUpdate: false, command: 'migrate-legacy-runtime',
    expectedRuntimeHead: oldHead, validatedCandidateHead: nextHead,
  });
  assert.equal(parseStage0Args(['--config', 'migrate-legacy-runtime']).command, null);
  assert.throws(() => parseStage0Args(['--expected-runtime-head', 'bad']), /exact 40-hex/u);
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

test('stage0 installation tags are stable per canonical installation and differ across installations', () => {
  const first = mkdtempSync(path.join(tmpdir(), 'db-stage0-tag-a-'));
  const second = mkdtempSync(path.join(tmpdir(), 'db-stage0-tag-b-'));
  assert.equal(stage0InstallationTag(first), stage0InstallationTag(path.join(first, '.')));
  assert.match(stage0InstallationTag(first), /^DB-[0-9A-F]{12}$/u);
  assert.notEqual(stage0InstallationTag(first), stage0InstallationTag(second));
  assert.equal(stage0InstallationTag(first).includes(first), false);
});

test('stage0 follows durable accepted runtime identity instead of falling back to original checkout', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'db-stage0-accepted-'));
  const paths = stage0Paths(home);
  const oldHead = '3'.repeat(40);
  const nextHead = '4'.repeat(40);
  writeRuntime(paths.runtime, oldHead, 1);
  const accepted = path.join(home, 'runtime-candidates', nextHead);
  writeRuntime(accepted, nextHead, 1);
  writeFileSync(paths.activationStateFile, `${JSON.stringify(activationRecord('healthy', accepted, nextHead))}\n`);
  const selected = selectStage0Runtime(paths, fakeGitRunner());
  assert.equal(selected.activationState, 'healthy');
  assert.equal(selected.runtime.head, nextHead);
  assert.equal(selected.runtime.runtimeDir, path.resolve(accepted));

  writeFileSync(paths.activationStateFile, `${JSON.stringify(activationRecord('activating', accepted, nextHead))}\n`);
  assert.throws(() => selectStage0Runtime(paths, fakeGitRunner()), /activation is incomplete \(activating\)/u);
});

test('stage0 refuses a runtime requiring a newer compatibility protocol', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'db-stage0-version-'));
  const paths = stage0Paths(home);
  writeRuntime(paths.runtime, '5'.repeat(40), STAGE0_PROTOCOL + 1);
  assert.throws(
    () => selectStage0Runtime(paths, fakeGitRunner()),
    new RegExp(`requires Stage 0 protocol ${STAGE0_PROTOCOL + 1}.*supports ${STAGE0_PROTOCOL}`, 'u'),
  );
});

test('dead interrupted stage0 migration rolls back exact saved runtime and live migration is not stolen', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'db-stage0-recovery-'));
  const paths = stage0Paths(home);
  const oldHead = '6'.repeat(40);
  const nextHead = '7'.repeat(40);
  const backupRuntime = path.join(paths.legacyRuntimeRoot, oldHead, 'runtime');
  writeRuntime(backupRuntime, oldHead, 0);
  writeRuntime(paths.runtime, nextHead, 1);
  writeFileSync(paths.migrationStateFile, `${JSON.stringify(migrationRecord(oldHead, nextHead))}\n`);
  assert.throws(
    () => reconcileStage0Migration(paths, { processAliveFn: () => true }),
    /migration is already in progress/u,
  );
  assert.equal(readFileSync(path.join(paths.runtime, '.fake-head'), 'utf8').trim(), nextHead);

  const recovered = reconcileStage0Migration(paths, { processAliveFn: () => false });
  assert.deepEqual(recovered, { state: 'rolled-back', previousHead: oldHead, abandonedHead: nextHead });
  assert.equal(readFileSync(path.join(paths.runtime, '.fake-head'), 'utf8').trim(), oldHead);
  assert.equal(existsSync(paths.migrationStateFile), false);
});

test('explicit legacy migration stages before stop and delegates healthy activation to the managed adapter', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'db-stage0-migrate-'));
  const paths = stage0Paths(home);
  const oldHead = '8'.repeat(40);
  const nextHead = '9'.repeat(40);
  const order = [];
  writeRuntime(paths.runtime, oldHead, 0);
  const runner = fakeGitRunner({
    remoteHead: nextHead,
    onClone: (destination) => { order.push('clone'); writeRuntime(destination, nextHead, 1); },
  });
  const calls = [];
  let imports = 0;
  const importModuleFn = async () => {
    imports += 1;
    if (imports === 1) {
      return {
        async bootstrap(argv, _runner, options) {
          calls.push({ kind: 'legacy', command: argv[0], argv: [...argv], options });
          if (argv[0] === 'stop') { order.push('stop'); return 0; }
          return 9;
        },
      };
    }
    return {
      async activateMigratedRuntime(input) {
        calls.push({ kind: 'activation', input });
        rmSync(paths.migrationStateFile, { force: true });
        return 0;
      },
    };
  };

  const status = await bootstrapStage0([
    'migrate-legacy-runtime', '--home', home,
    '--expected-runtime-head', oldHead, '--validated-candidate-head', nextHead,
  ], runner, { importModuleFn, processAliveFn: () => false });
  assert.equal(status, 0);
  assert.deepEqual(order, ['clone', 'stop']);
  assert.equal(calls[0].command, 'stop');
  assert.equal(calls[0].options.stage0Protocol, STAGE0_PROTOCOL);
  assert.ok(calls[0].argv.includes('--no-update'));
  assert.equal(calls[1].kind, 'activation');
  assert.equal(calls[1].input.stage0Protocol, STAGE0_PROTOCOL);
  assert.equal(calls[1].input.argv[0], 'daemon');
  assert.ok(calls[1].input.argv.includes('--no-update'));
  assert.deepEqual(calls[1].input.previous, { head: oldHead, runtimeDir: path.join(paths.legacyRuntimeRoot, oldHead, 'runtime') });
  assert.deepEqual(calls[1].input.candidate, { head: nextHead, runtimeDir: paths.runtime });
  assert.equal(readFileSync(path.join(paths.runtime, '.fake-head'), 'utf8').trim(), nextHead);
  assert.equal(readFileSync(path.join(paths.legacyRuntimeRoot, oldHead, 'runtime', '.fake-head'), 'utf8').trim(), oldHead);
  assert.equal(existsSync(paths.migrationStateFile), false);
});

test('failed managed compatibility activation restores exact legacy runtime', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'db-stage0-migrate-fail-'));
  const paths = stage0Paths(home);
  const oldHead = 'a'.repeat(40);
  const nextHead = 'b'.repeat(40);
  writeRuntime(paths.runtime, oldHead, 0);
  const runner = fakeGitRunner({
    remoteHead: nextHead,
    onClone: (destination) => writeRuntime(destination, nextHead, 1),
  });
  let imports = 0;
  const importModuleFn = async () => {
    imports += 1;
    if (imports === 1) return { async bootstrap(argv) { return argv[0] === 'stop' ? 0 : 9; } };
    return { async activateMigratedRuntime() { throw new Error('migrated runtime health failed'); } };
  };
  await assert.rejects(
    () => bootstrapStage0([
      'migrate-legacy-runtime', '--home', home,
      '--expected-runtime-head', oldHead, '--validated-candidate-head', nextHead,
    ], runner, { importModuleFn, processAliveFn: () => false }),
    /migrated runtime health failed/u,
  );
  assert.equal(readFileSync(path.join(paths.runtime, '.fake-head'), 'utf8').trim(), oldHead);
  assert.equal(existsSync(paths.migrationStateFile), false);
});

test('legacy runtime rename collision leaves the accepted runtime intact and retry state clean', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'db-stage0-migrate-rename-'));
  const paths = stage0Paths(home);
  const oldHead = 'c'.repeat(40);
  const nextHead = 'd'.repeat(40);
  writeRuntime(paths.runtime, oldHead, 0);
  const runner = fakeGitRunner({
    remoteHead: nextHead,
    onClone: (destination) => writeRuntime(destination, nextHead, 1),
  });
  const importModuleFn = async () => ({
    async bootstrap(argv) {
      if (argv[0] !== 'stop') return 9;
      const blocker = path.join(paths.legacyRuntimeRoot, oldHead, 'runtime');
      mkdirSync(blocker, { recursive: true });
      writeFileSync(path.join(blocker, 'blocker.txt'), 'occupied\n');
      return 0;
    },
  });

  await assert.rejects(() => bootstrapStage0([
    'migrate-legacy-runtime', '--home', home,
    '--expected-runtime-head', oldHead, '--validated-candidate-head', nextHead,
  ], runner, { importModuleFn, processAliveFn: () => false }));

  assert.equal(readFileSync(path.join(paths.runtime, '.fake-head'), 'utf8').trim(), oldHead);
  assert.equal(existsSync(path.join(paths.legacyRuntimeRoot, oldHead)), false);
  assert.equal(existsSync(paths.migrationStateFile), false);
  assert.equal(existsSync(path.join(paths.migrationCandidateRoot, nextHead)), false);
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
  const paths = resolveManagedBootstrapPaths(args, {});
  mkdirSync(path.join(paths.runtime, 'config'), { recursive: true });
  const example = path.join(paths.runtime, 'config', 'devbridge.example.json');
  writeFileSync(example, '{"safe":true}\n');
  assert.equal(prepareLocalConfig(paths), true);
  assert.equal(readFileSync(paths.config, 'utf8'), '{"safe":true}\n');
  writeFileSync(paths.config, '{"operator":true}\n');
  writeFileSync(example, '{"safe":false}\n');
  assert.equal(prepareLocalConfig(paths), false);
  assert.equal(readFileSync(paths.config, 'utf8'), '{"operator":true}\n');
});

test('node version gate rejects older runtimes', () => {
  assert.doesNotThrow(() => assertSupportedNode('22.16.0'));
  assert.doesNotThrow(() => assertSupportedNode('24.0.0'));
  assert.throws(() => assertSupportedNode('22.15.9'), /22\.16\.0 or newer/u);
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
