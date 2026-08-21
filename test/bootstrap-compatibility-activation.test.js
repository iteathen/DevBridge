import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activateMigratedRuntime } from '../src/bootstrap/compatibility-activation.mjs';

function writeManagedRuntime(directory, head) {
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  mkdirSync(path.join(directory, 'src'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name: 'devbridge', version: '0.1.0' })}\n`);
  writeFileSync(path.join(directory, 'src', 'cli.js'), 'process.exitCode = 0;\n');
  writeFileSync(path.join(directory, '.fake-head'), `${head}\n`);
}

function fakeGitRunner(_executable, args, options = {}) {
  if (args.includes('remote') && args.includes('get-url')) {
    return { status: 0, stdout: 'https://github.com/iteathen/DevBridge.git\n', stderr: '' };
  }
  if (args.includes('status') && args.includes('--porcelain')) {
    return { status: 0, stdout: '', stderr: '' };
  }
  if (args.includes('rev-parse') && args.includes('HEAD')) {
    const head = String(requireHead(options.cwd));
    return { status: 0, stdout: `${head}\n`, stderr: '' };
  }
  throw new Error(`unexpected fake git invocation: ${args.join(' ')}`);
}

function requireHead(directory) {
  const marker = path.join(directory, '.fake-head');
  return String(new TextDecoder().decode(requireBytes(marker))).trim();
}

function requireBytes(file) {
  return Buffer.from(require('node:fs').readFileSync(file));
}

test('compatibility activation clears migration ownership only after durable healthy activation', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'db-compat-activation-'));
  const previousHead = '1'.repeat(40);
  const candidateHead = '2'.repeat(40);
  const previousRuntime = path.join(home, 'legacy-runtime-migrations', previousHead, 'runtime');
  const candidateRuntime = path.join(home, 'runtime');
  const migrationState = path.join(home, 'stage0-migration.json');
  writeManagedRuntime(previousRuntime, previousHead);
  writeManagedRuntime(candidateRuntime, candidateHead);
  writeFileSync(migrationState, '{"protocol":"devbridge/stage0-migration-v1","state":"transitioning"}\n');

  const ownerController = new AbortController();
  let released = false;
  const records = [];
  const result = await activateMigratedRuntime({
    argv: ['daemon', '--home', home, '--config', path.join(home, 'config.json'), '--no-update'],
    previous: { head: previousHead, runtimeDir: previousRuntime },
    candidate: { head: candidateHead, runtimeDir: candidateRuntime },
    runner: fakeGitRunner,
    stage0Protocol: 1,
    acquireInstallationOwnerFn: async () => ({
      signal: ownerController.signal,
      async release() { released = true; },
    }),
    writeActivationStateFn: async (_paths, record) => {
      records.push(record);
      return record;
    },
    superviseDaemonFn: async (_args, paths, runtime, options) => {
      assert.equal(runtime.head, candidateHead);
      assert.equal(options.stopExisting, false);
      assert.equal(options.initialActivation.previous.head, previousHead);
      assert.equal(options.initialActivation.candidate.head, candidateHead);
      await options.recordActivationFn(paths, {
        protocol: 'devbridge/runtime-activation-v1',
        state: 'candidate-validated',
        current: { head: previousHead },
      });
      assert.equal(existsSync(migrationState), true);
      await options.recordActivationFn(paths, {
        protocol: 'devbridge/runtime-activation-v1',
        state: 'healthy',
        current: { head: candidateHead },
      });
      assert.equal(existsSync(migrationState), false);
      return 0;
    },
  });

  assert.equal(result, 0);
  assert.equal(released, true);
  assert.deepEqual(records.map((record) => record.state), ['candidate-validated', 'healthy']);
});
