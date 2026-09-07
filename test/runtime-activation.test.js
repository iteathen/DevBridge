import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  candidateRuntimePath,
  loadPersistedHealthyRuntime,
  prepareRuntimeCandidate,
  readRuntimeActivationState,
  runDevBridgeCli,
  writeRuntimeActivationState,
} from '../src/bootstrap/secure-bootstrap.mjs';

function fixturePaths() {
  const home = mkdtempSync(path.join(tmpdir(), 'devbridge-runtime-activation-'));
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
      desiredRef: 'main',
      desiredHead: expected,
      ensureRuntimeFn: () => ({
        ref: 'main',
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
      desiredRef: 'main',
      desiredHead: head,
      ensureRuntimeFn: () => {
        events.push('materialized');
        return { ref: 'main', head, cliPath: path.join(runtimeDir, 'src', 'cli.js'), version: '0.1.0' };
      },
      validateCandidateFn: (_paths, runtime, _runner, options) => {
        events.push(`validated:${runtime.head}`);
        return {
          tests: 'passed',
          artifactSha256: options.expectedArtifactSha256,
          execution: { identity: 'fixture-execution', ready: true },
        };
      },
    },
  );
  assert.deepEqual(events, ['materialized', `validated:${head}`]);
  assert.equal(candidate.runtimeDir, runtimeDir);
  assert.equal(candidate.head, head);
  assert.match(candidate.artifactSha256, /^[0-9a-f]{64}$/u);
  assert.equal(candidate.validation.artifactSha256, candidate.artifactSha256);
  assert.equal(candidate.validation.execution.identity, 'fixture-execution');
  assert.equal(candidate.releaseIntegrity.mode, 'development');
});

test('candidate preparation accepts exact source availability without invoking the GitHub materializer', async () => {
  const paths = fixturePaths();
  const head = '7'.repeat(40);
  const runtimeDir = candidateRuntimePath(paths, head);
  const sourceCalls = [];
  const runner = (_executable, args) => {
    const command = args.at(-3) === 'remote' ? 'remote' : args.at(-2) === 'status' ? 'status' : args.at(-2) === 'rev-parse' ? 'rev-parse' : null;
    if (command === 'remote') return { status: 0, stdout: 'https://github.com/iteathen/DevBridge.git\n', stderr: '' };
    if (command === 'status') return { status: 0, stdout: '', stderr: '' };
    if (command === 'rev-parse') return { status: 0, stdout: `${head}\n`, stderr: '' };
    throw new Error(`unexpected Git command: ${args.join(' ')}`);
  };
  const candidate = await prepareRuntimeCandidate(
    { channel: 'testing', update: true, releaseMode: 'development' },
    paths,
    {
      desiredRef: 'main',
      desiredHead: head,
      runner,
      source: {
        async prepare(input) {
          sourceCalls.push(input);
          mkdirSync(path.join(runtimeDir, '.git'), { recursive: true });
          mkdirSync(path.join(runtimeDir, 'src'), { recursive: true });
          writeFileSync(path.join(runtimeDir, 'package.json'), '{"name":"devbridge","version":"0.1.0"}\n');
          writeFileSync(path.join(runtimeDir, 'src', 'cli.js'), 'export {};\n');
          return { head, root: runtimeDir };
        },
      },
      ensureRuntimeFn() { throw new Error('network materializer must not run'); },
      validateCandidateFn: (_paths, _runtime, _runner, options) => ({
        tests: 'passed',
        artifactSha256: options.expectedArtifactSha256,
        execution: { identity: 'source-port-fixture', ready: true },
      }),
    },
  );
  assert.equal(sourceCalls.length, 1);
  assert.equal(sourceCalls[0].head, head);
  assert.equal(candidate.head, head);
  assert.equal(candidate.runtimeDir, runtimeDir);
  assert.equal(candidate.validation.execution.identity, 'source-port-fixture');
});

test('activation journal is atomic JSON and only a contained exact healthy runtime is rehydrated', () => {
  const paths = fixturePaths();
  const head = 'e'.repeat(40);
  const runtimeDir = candidateRuntimePath(paths, head);
  mkdirSync(runtimeDir, { recursive: true });
  writeRuntimeActivationState(paths, {
    protocol: 'devbridge/runtime-activation-v1',
    state: 'healthy',
    current: { ref: 'main', head, runtimeDir, cliPath: path.join(runtimeDir, 'src', 'cli.js'), version: '0.1.0' },
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
  assert.equal(loaded.ref, 'main');
  assert.equal(loaded.runtimeDir, runtimeDir);

  writeRuntimeActivationState(paths, {
    protocol: 'devbridge/runtime-activation-v1',
    state: 'healthy',
    current: { ref: 'main', head, runtimeDir: path.resolve(paths.home, '..', 'escape'), cliPath: '/escape/src/cli.js', version: '0.1.0' },
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
  assert.equal(runDevBridgeCli('doctor', paths, runtime, runner), 0);
  assert.equal(observed.options.cwd, runtimeDir);
  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.args, [runtime.cliPath, 'doctor', '--config', paths.config]);
});
