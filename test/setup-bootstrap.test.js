import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseBootstrapArgs,
  prepareLocalConfig,
  resolveBootstrapPaths,
  runDevBridgeCli,
} from '../src/bootstrap/runtime-bootstrap.mjs';

test('managed bootstrap accepts setup repository selection but no other command does', () => {
  assert.deepEqual(parseBootstrapArgs(['setup', '--repository', 'owner/one', '--repository', 'owner/two']), {
    command: 'setup',
    channel: 'testing',
    home: null,
    config: null,
    update: true,
    repositories: ['owner/one', 'owner/two'],
  });
  assert.throws(() => parseBootstrapArgs(['doctor', '--repository', 'owner/one']), /valid only with devbridge setup/u);
});

test('setup bootstrap does not create the legacy example config', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'db-zero-bootstrap-'));
  const args = parseBootstrapArgs(['setup', '--home', home]);
  const paths = resolveBootstrapPaths(args, {});
  mkdirSync(path.join(paths.runtime, 'config'), { recursive: true });
  writeFileSync(path.join(paths.runtime, 'config', 'devbridge.example.json'), '{"legacy":true}\n');
  assert.equal(prepareLocalConfig(paths), false);
  assert.equal(existsSync(paths.config), false);
});

test('setup bootstrap bypasses config-backed doctor and invokes setup with home, repositories, and Stage 0 authority', () => {
  const previous = process.env.DEVBRIDGE_STAGE0_LAUNCHER;
  process.env.DEVBRIDGE_STAGE0_LAUNCHER = path.resolve('/trusted/devbridge.mjs');
  try {
    const paths = {
      home: path.resolve('/managed/home'),
      runtime: path.resolve('/managed/home/runtime'),
      config: path.resolve('/managed/home/config.json'),
      command: 'setup',
      repositories: ['owner/one', 'owner/two'],
    };
    const runtime = { cliPath: path.resolve('/managed/home/runtime/src/cli.js') };
    let calls = 0;
    const runner = (executable, args, options) => {
      calls += 1;
      assert.equal(executable, process.execPath);
      assert.deepEqual(args, [
        runtime.cliPath,
        'setup',
        '--home',
        paths.home,
        '--repository',
        'owner/one',
        '--repository',
        'owner/two',
      ]);
      assert.equal(args.includes('--config'), false);
      assert.equal(options.env.DEVBRIDGE_STAGE0_LAUNCHER, path.resolve('/trusted/devbridge.mjs'));
      assert.equal(options.shell, false);
      return { status: 0 };
    };
    assert.equal(runDevBridgeCli('doctor', paths, runtime, runner), 0);
    assert.equal(calls, 0);
    assert.equal(runDevBridgeCli('setup', paths, runtime, runner), 0);
    assert.equal(calls, 1);
  } finally {
    if (previous == null) delete process.env.DEVBRIDGE_STAGE0_LAUNCHER;
    else process.env.DEVBRIDGE_STAGE0_LAUNCHER = previous;
  }
});
