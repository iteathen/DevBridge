import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  candidateRuntimePath,
  loadPersistedHealthyRuntime,
  prepareRuntimeCandidate,
  readRuntimeActivationState,
  runPollerCli,
  writeRuntimeActivationState,
} from '../patch-poller.mjs';

function fixturePaths() {
  const home = mkdtempSync(path.join(tmpdir(), 'pp-runtime-activation-'));
  return {
    home,
    runtime: path.join(home, 'runtime'),
    runtimeCandidates: path.join(home, 'runtime-candidates'),
    activationStateFile: path.join(home, 'runtime-activation.json'),
    config: path.join(home, 'config.json'),
    gitHome: path.join(home, 'git-home'),
    hooks: path.join(home, 'hooks'),
  };
}

test('candidate runtime locations are locally derived from exact commit SHA', () => {
  const paths = fixturePaths();
  const head = 'a'.repeat(40);
  assert.equal(candidateRuntimePath(paths, head), path.join(paths.runtimeCandidates, head));
  assert.throws(() => candidateRuntimePath(paths, '../evil'), /exact 40-hex SHA/u);
});

test('candidate preparation rejects a ref/head race before activation validation can succeed', async () => {
  const paths = fixturePaths();
  const expected = 'b'.repeat(40);
  let validations = 0;
  await assert.rejects(() => prepareRuntimeCandidate(
    { channel: 'testing', update: true, releaseMode: 'development' },
    paths,
    {
      desiredRef: 'sol/foundation-bootstrap',
      desiredHead: expected,
      ensureRuntimeFn: () => ({
        ref: 'sol/foundation-bootstrap',
        head: 'c'.repeat(40),
        cliPath: path.join(paths.runtimeCandidates, expected, 'src', 'cli.js'),
        version: '0.1.0',
      }),
      validateCandidateFn: () => { validations += 1; },
    },
  ), /changed during preparation/u);
  assert.equal(validations, 0);
});

test('candidate preparation validates and returns the exact tested separate runtime digest', async () => {
  const paths = fixturePaths();
  const head = 'd'.repeat(40);
  const runtimeDir = candidateRuntimePath(paths, head);
  mkdirSync(runtimeDir, { recursive: true });
  const events = [];
  const candidate = await prepareRuntimeCandidate(
    { channel: 'testing', update: true, releaseMode: 'development' },
    paths,
    {
      desiredRef: 'sol/foundation-bootstrap',
      desiredHead: head,
      ensureRuntimeFn: () => {
        events.push('materialized');
        return { ref: 'sol/foundation-bootstrap', head, cliPath: path.join(runtimeDir, 'src', 'cli.js'), version: '0.1.0' };
      },
      validateCandidateFn: (_paths, runtime, _runner, options) => {
        events.push(`validated:${runtime.head}`);
        return {
          tests: 'passed-sandboxed',
          artifactSha256: options.expectedArtifactSha256,
          sandbox: { provider: 'fixture', verified: true },
        };
      },
    },
  );
  assert.deepEqual(events, ['materialized', `validated:${head}`]);
  assert.equal(candidate.runtimeDir, runtimeDir);
  assert.equal(candidate.head, head);
  assert.match(candidate.artifactSha256, /^[0-9a-f]{64}$/u);
  assert.equal(candidate.validation.artifactSha256, candidate.artifactSha256);
  assert.equal(candidate.releaseIntegrity.mode, 'development');
});

test('activation journal is atomic JSON and only a contained exact healthy runtime is rehydrated', () => {
  const paths = fixturePaths();
  const head = 'e'.repeat(40);
  const runtimeDir = candidateRuntimePath(paths, head);
  mkdirSync(runtimeDir, { recursive: true });
  writeRuntimeActivationState(paths, {
    protocol: 'patch-poller/runtime-activation-v1',
    state: 'healthy',
    current: { ref: 'sol/foundation-bootstrap', head, runtimeDir, cliPath: path.join(runtimeDir, 'src', 'cli.js'), version: '0.1.0' },
  });
  assert.equal(readRuntimeActivationState(paths).current.head, head);
  const loaded = loadPersistedHealthyRuntime(paths, undefined, {
    ensureRuntimeFn: (_args, localPaths) => ({
      ref: 'existing',
      head,
      cliPath: path.join(localPaths.runtime, 'src', 'cli.js'),
      version: '0.1.0',
    }),
  });
  assert.equal(loaded.head, head);
  assert.equal(loaded.ref, 'sol/foundation-bootstrap');
  assert.equal(loaded.runtimeDir, runtimeDir);

  writeRuntimeActivationState(paths, {
    protocol: 'patch-poller/runtime-activation-v1',
    state: 'healthy',
    current: { ref: 'sol/foundation-bootstrap', head, runtimeDir: path.resolve(paths.home, '..', 'escape'), cliPath: '/escape/src/cli.js', version: '0.1.0' },
  });
  assert.equal(loadPersistedHealthyRuntime(paths, undefined, { ensureRuntimeFn: () => { throw new Error('must not inspect escape'); } }), null);
});

test('runtime-aware CLI launch uses candidate cwd and never a shell', () => {
  const paths = fixturePaths();
  const head = 'f'.repeat(40);
  const runtimeDir = candidateRuntimePath(paths, head);
  const runtime = { head, ref: 'testing', version: '0.1.0', runtimeDir, cliPath: path.join(runtimeDir, 'src', 'cli.js') };
  let observed;
  const runner = (executable, args, options) => {
    observed = { executable, args, options };
    return { status: 0 };
  };
  assert.equal(runPollerCli('doctor', paths, runtime, runner), 0);
  assert.equal(observed.options.cwd, runtimeDir);
  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.args, [runtime.cliPath, 'doctor', '--config', paths.config]);
});
