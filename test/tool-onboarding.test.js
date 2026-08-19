import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DeterministicOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { parseCliHelp, ToolOnboardingService, validateToolOnboardingPolicy } from '../src/runtime/tool-onboarding.js';

function platformExecutable(name) {
  return process.platform === 'win32' ? `${name}.EXE` : name;
}

function isolatedPathEnv(binDir) {
  if (process.platform === 'win32') return { Path: binDir, PATH: binDir, PATHEXT: '.EXE;.CMD' };
  return { PATH: binDir };
}

const HELP = `Usage: magic-tool [OPTIONS] <INPUT>\n\nOptions:\n  --json                 Emit JSON\n  --jobs <COUNT>         Worker count\n  --output <PATH>        Project output path\n  --env <VALUE>          Dangerous authority-like parameter\n  --mode <WHEN>          Mode\n`;

test('help parser synthesizes only bounded safe flags/options/positionals', () => {
  const parsed = parseCliHelp(HELP);
  assert.match(parsed.helpSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(parsed.commands, []);
  assert.deepEqual(parsed.arguments, [
    { kind: 'flag', param: 'json', flag: '--json' },
    { kind: 'option', param: 'jobs', flag: '--jobs', required: false, repeat: false, valueType: 'integer' },
    { kind: 'option', param: 'output', flag: '--output', required: false, repeat: false, valueType: 'project-path' },
    { kind: 'option', param: 'mode', flag: '--mode', required: false, repeat: false, valueType: 'string' },
    { kind: 'positional', param: 'input', required: true, repeat: false, valueType: 'string' },
  ]);
  assert.equal(parsed.arguments.some((entry) => entry.param === 'env'), false);
});

test('automatic onboarding requires an exact local command policy and probes help only inside the repository-code sandbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-onboarding-'));
  const bin = path.join(root, 'bin');
  const workspace = path.join(root, 'workspace');
  const manifests = path.join(root, 'manifests');
  await Promise.all([mkdir(bin), mkdir(workspace), mkdir(manifests)]);
  const command = 'magic-tool';
  await writeFile(path.join(bin, platformExecutable(command)), '', { mode: 0o755 });
  const env = isolatedPathEnv(bin);
  const registry = new DeterministicOperationRegistry();
  const probeCalls = [];
  const service = new ToolOnboardingService({
    operationRegistry: registry,
    processRunner: {
      run: async (request) => {
        probeCalls.push(request);
        return { exitCode: 0, timedOut: false, outputTruncated: false, stdout: HELP, stderr: '' };
      },
    },
    workspaceRoot: workspace,
    manifestDirectory: manifests,
    autoIntegrate: [{ command, operation: 'tool.magic' }],
    env,
  });

  try {
    const first = await service.reconcile();
    assert.equal(first.changed, true);
    assert.equal(first.events[0].state, 'registered-synthesized');
    assert.equal(registry.has('tool.magic'), true);
    assert.equal(probeCalls.length, 1);
    assert.deepEqual(probeCalls[0].args, ['--help']);
    assert.equal(probeCalls[0].executionClass, 'repository-code');
    assert.equal(probeCalls[0].sandbox.required, true);
    assert.equal(probeCalls[0].sandbox.network, 'deny');
    assert.equal(probeCalls[0].sandbox.exposeConfiguredReadRoots, false);
    assert.equal(probeCalls[0].environment.pass.includes('GH_TOKEN'), false);
    assert.equal(probeCalls[0].environment.pass.includes('GITHUB_TOKEN'), false);

    const files = (await import('node:fs/promises')).readdir;
    const generated = (await files(manifests)).filter((name) => name.endsWith('.json'));
    assert.equal(generated.length, 1);
    const manifest = JSON.parse(await readFile(path.join(manifests, generated[0]), 'utf8'));
    assert.equal(manifest.source.kind, 'help-synthesized');
    assert.equal(manifest.source.command, command);
    assert.match(manifest.source.helpSha256, /^[0-9a-f]{64}$/u);
    assert.equal(manifest.arguments.some((entry) => entry.param === 'env'), false);

    const executionCalls = [];
    await registry.execute('tool.magic', {
      json: true,
      jobs: 4,
      output: 'out/report.json',
      input: 'src/data.txt',
    }, {
      projectDir: workspace,
      processRunner: {
        run: async (request) => {
          executionCalls.push(request);
          return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
        },
      },
    });
    assert.deepEqual(executionCalls[0].args, [
      '--json', '--jobs', '4', '--output', 'out/report.json', 'src/data.txt',
    ]);
    assert.equal(executionCalls[0].executionClass, 'repository-code');
    assert.equal(executionCalls[0].sandbox.network, 'deny');

    const second = await service.reconcile();
    assert.equal(second.changed, false);
    assert.equal(second.events[0].state, 'registered-existing');
    assert.equal(probeCalls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unavailable or blocked local tools never become registered capabilities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-onboarding-blocked-'));
  const workspace = path.join(root, 'workspace');
  const manifests = path.join(root, 'manifests');
  await Promise.all([mkdir(workspace), mkdir(manifests)]);
  try {
    const unavailableRegistry = new DeterministicOperationRegistry();
    const unavailable = new ToolOnboardingService({
      operationRegistry: unavailableRegistry,
      processRunner: { run: async () => { throw new Error('must not execute'); } },
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      autoIntegrate: [{ command: 'definitely-not-installed-pp-tool', operation: 'tool.missing' }],
      env: isolatedPathEnv(path.join(root, 'empty-bin')),
    });
    const missing = await unavailable.reconcile();
    assert.equal(missing.changed, false);
    assert.equal(missing.events[0].state, 'unavailable');
    assert.equal(unavailableRegistry.has('tool.missing'), false);

    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, platformExecutable('blocked-tool')), '', { mode: 0o755 });
    const blockedRegistry = new DeterministicOperationRegistry();
    const blocked = new ToolOnboardingService({
      operationRegistry: blockedRegistry,
      processRunner: { run: async () => { throw new Error('verified sandbox unavailable /private/control/path'); } },
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      autoIntegrate: [{ command: 'blocked-tool', operation: 'tool.blocked' }],
      env: isolatedPathEnv(bin),
    });
    const result = await blocked.reconcile();
    assert.equal(result.changed, false);
    assert.equal(result.events[0].state, 'probe-blocked');
    assert.equal(blockedRegistry.has('tool.blocked'), false);
    assert.deepEqual((await import('node:fs/promises')).readdir ? (await (await import('node:fs/promises')).readdir(manifests)).filter((name) => name.includes('blocked')) : [], []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local onboarding policy rejects remote-shell shaped configuration', () => {
  assert.throws(
    () => validateToolOnboardingPolicy({ autoIntegrate: [{ command: 'tool;rm', helpArgs: ['--help'] }] }),
    /command is invalid/u,
  );
  assert.throws(
    () => validateToolOnboardingPolicy({ autoIntegrate: [{ command: 'tool', helpArgs: ['help;rm'] }] }),
    /fixed safe option arguments/u,
  );
  assert.throws(
    () => validateToolOnboardingPolicy({ autoIntegrate: [{ command: 'tool', operation: 'shell.exec' }] }),
    /operation is invalid/u,
  );
});
