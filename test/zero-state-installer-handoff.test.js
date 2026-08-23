import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseInstallArgs, runInstalledSetup } from '../install-devbridge.mjs';

test('standalone installer enters setup by default and install-only is explicit', () => {
  const root = path.resolve('test-home');
  const normal = parseInstallArgs(['--ref', 'cuda-target', '--home', root], { environment: {}, homeDirectory: root });
  assert.equal(normal.runSetup, true);
  assert.equal(normal.pinSelectedRunner, true);

  const installOnly = parseInstallArgs(['--install-only', '--ref', 'cuda-target', '--home', root], { environment: {}, homeDirectory: root });
  assert.equal(installOnly.runSetup, false);
  assert.equal(installOnly.pinSelectedRunner, true);
});

test('installer handoff invokes only the exact installed entry wrapper setup surface', () => {
  const home = path.resolve('installed-home');
  const launcher = path.join(home, 'bin', 'devbridge-entry.mjs');
  let observed = null;
  const status = runInstalledSetup({ home, wrappers: { javascript: launcher } }, {
    environment: { TEST_SETUP_ENV: '1' },
    runner(executable, args, options) {
      observed = { executable, args, options };
      return { status: 3, error: null };
    },
  });

  assert.equal(status, 3);
  assert.equal(observed.executable, process.execPath);
  assert.deepEqual(observed.args, [launcher, 'setup']);
  assert.equal(observed.options.cwd, home);
  assert.equal(observed.options.env.TEST_SETUP_ENV, '1');
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.stdio, 'inherit');
});
