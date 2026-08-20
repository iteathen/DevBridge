import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeterministicOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { LOCAL_OPERATION_MANIFEST_PROTOCOL } from '../src/runtime/local-operation-manifest.js';
import { REPOSITORY_EXECUTION_STATUS_PROTOCOL } from '../src/runtime/repository-execution.js';
import { parseCliHelp, ToolOnboardingService, validateToolOnboardingPolicy } from '../src/runtime/tool-onboarding.js';

const HELP = `Usage: magic-tool [OPTIONS] <INPUT>\n\nOptions:\n  --json                 Emit JSON\n  --jobs <COUNT>         Worker count\n  --output <PATH>        Project output path\n  --env <VALUE>          Dangerous authority-like parameter\n  --mode <WHEN>          Mode\n`;

function executionStatus(ready) {
  return {
    inspect() {
      return ready
        ? { protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'fixture', reason: null }
        : { protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'unavailable', ready: false, identity: null, reason: 'stage-1-no-provider' };
    },
    async execute() { throw new Error('onboarding must not execute without exact repository scope'); },
  };
}

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

test('automatic onboarding does not probe host executables during the Stage-1 no-provider interval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-onboarding-unavailable-'));
  const workspace = path.join(root, 'workspace');
  const manifests = path.join(root, 'manifests');
  await Promise.all([mkdir(workspace), mkdir(manifests)]);
  try {
    const registry = new DeterministicOperationRegistry();
    const service = new ToolOnboardingService({
      operationRegistry: registry,
      repositoryExecution: executionStatus(false),
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      autoIntegrate: [{ command: 'magic-tool', operation: 'tool.magic' }],
    });
    const result = await service.reconcile();
    assert.equal(result.changed, false);
    assert.equal(result.events[0].state, 'repository-execution-unavailable');
    assert.equal(result.events[0].reason, 'stage-1-no-provider');
    assert.equal(registry.has('tool.magic'), false);
    assert.deepEqual(await readdir(manifests), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a ready executor still does not authorize onboarding without an exact repository environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-onboarding-scope-'));
  const workspace = path.join(root, 'workspace');
  const manifests = path.join(root, 'manifests');
  await Promise.all([mkdir(workspace), mkdir(manifests)]);
  try {
    const service = new ToolOnboardingService({
      operationRegistry: new DeterministicOperationRegistry(),
      repositoryExecution: executionStatus(true),
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      autoIntegrate: [{ command: 'magic-tool', operation: 'tool.magic' }],
    });
    const result = await service.reconcile();
    assert.equal(result.changed, false);
    assert.equal(result.events[0].state, 'repository-scope-required');
    assert.match(result.events[0].reason, /exact repository environment/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing control-owned synthesized manifest can be registered without probing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-onboarding-existing-'));
  const workspace = path.join(root, 'workspace');
  const manifests = path.join(root, 'manifests');
  await Promise.all([mkdir(workspace), mkdir(manifests)]);
  try {
    const manifest = {
      protocol: LOCAL_OPERATION_MANIFEST_PROTOCOL,
      operation: 'tool.magic',
      executable: 'magic-tool',
      arguments: [{ kind: 'flag', param: 'json', flag: '--json' }],
      requireAnyParameter: true,
      source: { kind: 'help-synthesized', command: 'magic-tool', helpSha256: 'a'.repeat(64) },
    };
    await writeFile(path.join(manifests, 'auto-tool.magic.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const registry = new DeterministicOperationRegistry();
    const service = new ToolOnboardingService({
      operationRegistry: registry,
      repositoryExecution: executionStatus(false),
      workspaceRoot: workspace,
      manifestDirectory: manifests,
      autoIntegrate: [{ command: 'magic-tool', operation: 'tool.magic' }],
    });
    const result = await service.reconcile();
    assert.equal(result.changed, false);
    assert.equal(result.events[0].state, 'registered-existing');
    assert.equal(registry.has('tool.magic'), true);
    const stored = JSON.parse(await readFile(path.join(manifests, 'auto-tool.magic.json'), 'utf8'));
    assert.equal(stored.source.command, 'magic-tool');
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
