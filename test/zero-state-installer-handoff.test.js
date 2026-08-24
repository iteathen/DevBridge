import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseInstallArgs, runInstalledSetup } from '../install-devbridge.mjs';

const HEAD = 'a'.repeat(40);

test('standalone installer enters setup by default and install-only is explicit', () => {
  const root = path.resolve('test-home');
  const normal = parseInstallArgs(['--ref', 'cuda-target', '--home', root], { environment: {}, homeDirectory: root });
  assert.equal(normal.runSetup, true);
  assert.equal(normal.selectedRunnerRef, 'cuda-target');
  assert.equal(normal.pinSelectedRunner, false);

  const installOnly = parseInstallArgs(['--install-only', '--ref', 'cuda-target', '--home', root], { environment: {}, homeDirectory: root });
  assert.equal(installOnly.runSetup, false);
  assert.equal(installOnly.selectedRunnerRef, 'cuda-target');
  assert.equal(installOnly.pinSelectedRunner, false);

  const exact = parseInstallArgs(['--ref', HEAD, '--home', root], { environment: {}, homeDirectory: root });
  assert.equal(exact.selectedRunnerRef, HEAD);
  assert.equal(exact.pinSelectedRunner, true);
});

test('installer handoff keeps an explicitly selected install on its exact resolved subject', () => {
  const home = path.resolve('installed-home');
  const launcher = path.join(home, 'bin', 'devbridge-entry.mjs');
  let observed = null;
  const status = runInstalledSetup({
    home,
    componentHead: HEAD,
    selectedRunnerRef: 'cuda-target',
    wrappers: { javascript: launcher },
  }, {
    environment: { TEST_SETUP_ENV: '1' },
    runner(executable, args, options) {
      observed = { executable, args, options };
      return { status: 3, error: null };
    },
  });

  assert.equal(status, 3);
  assert.equal(observed.executable, process.execPath);
  assert.deepEqual(observed.args, [launcher, '--ref', HEAD, 'setup']);
  assert.equal(observed.options.cwd, home);
  assert.equal(observed.options.env.TEST_SETUP_ENV, '1');
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.stdio, 'inherit');
});

test('stable installer handoff remains on the normal stable entry surface', () => {
  const home = path.resolve('stable-home');
  const launcher = path.join(home, 'bin', 'devbridge-entry.mjs');
  let observed = null;
  const status = runInstalledSetup({
    home,
    componentHead: HEAD,
    selectedRunnerRef: null,
    wrappers: { javascript: launcher },
  }, {
    runner(executable, args) {
      observed = { executable, args };
      return { status: 0, error: null };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(observed.args, [launcher, 'setup']);
});
