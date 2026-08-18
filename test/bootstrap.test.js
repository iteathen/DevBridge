import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertSupportedNode,
  managedGitEnvironment,
  parseBootstrapArgs,
  prepareLocalConfig,
  resolveBootstrapPaths,
  runPollerCli,
} from '../patch-poller.mjs';

test('bootstrap defaults to testing channel and daemon', () => {
  assert.deepEqual(parseBootstrapArgs([]), {
    command: 'daemon',
    channel: 'testing',
    home: null,
    config: null,
    update: true,
  });
});

test('bootstrap accepts one safe command and local-only switches', () => {
  assert.deepEqual(
    parseBootstrapArgs(['run-once', '--channel', 'stable', '--home', '/tmp/pp', '--no-update']),
    {
      command: 'run-once',
      channel: 'stable',
      home: '/tmp/pp',
      config: null,
      update: false,
    },
  );
  for (const command of ['status', 'stop', 'restart']) {
    assert.equal(parseBootstrapArgs([command]).command, command);
  }
  assert.throws(() => parseBootstrapArgs(['--channel', 'evil']), /Unknown PATCH-POLLER channel/u);
  assert.throws(() => parseBootstrapArgs(['daemon', 'run-once']), /Only one/u);
  assert.throws(() => parseBootstrapArgs(['--repository', 'attacker/repo']), /Unknown bootstrap argument/u);
});

test('managed Git environment removes inherited Git and SSH authority', () => {
  const paths = { gitHome: '/safe/home' };
  const env = managedGitEnvironment(paths, {
    PATH: '/bin',
    GIT_DIR: '/attacker/gitdir',
    GIT_CONFIG_COUNT: '1',
    GIT_SSH_COMMAND: 'evil',
    SSH_AUTH_SOCK: '/secret/agent',
  }, 'linux');
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
});

test('first run creates config outside the managed runtime without overwriting it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'patch-poller-bootstrap-'));
  const args = parseBootstrapArgs(['--home', root]);
  const paths = resolveBootstrapPaths(args, {});
  mkdirSync(path.join(paths.runtime, 'config'), { recursive: true });
  const example = path.join(paths.runtime, 'config', 'patch-poller.example.json');
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

test('poller CLI launch never uses a shell', () => {
  let observed;
  const runner = (executable, args, options) => {
    observed = { executable, args, options };
    return { status: 0 };
  };
  const status = runPollerCli(
    'poll-once',
    { runtime: '/managed/runtime', config: '/operator/config.json' },
    { cliPath: '/managed/runtime/src/cli.js' },
    runner,
  );
  assert.equal(status, 0);
  assert.equal(observed.executable, process.execPath);
  assert.deepEqual(observed.args, [
    '/managed/runtime/src/cli.js', 'poll-once', '--config', '/operator/config.json',
  ]);
  assert.equal(observed.options.shell, false);
});
