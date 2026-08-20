import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeterministicOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { LOCAL_OPERATION_MANIFEST_PROTOCOL } from '../src/runtime/local-operation-manifest.js';
import { parseCliHelp } from '../src/runtime/cli-help-parser.js';
import { ToolOnboarding } from '../src/runtime/tool-onboarding.js';
import { validateToolOnboardingPolicy } from '../src/runtime/tool-onboarding-policy.js';

const HELP = `Usage: magic-tool [OPTIONS] <INPUT>\n\nOptions:\n  --json                 Emit JSON\n  --jobs <COUNT>         Worker count\n  --output <PATH>        Project output path\n  --env <VALUE>          Dangerous authority-like parameter\n  --mode <WHEN>          Mode\n`;

function probe({ ready = true, reason = null, run = async () => { throw new Error('probe must not run'); } } = {}) {
  return { inspect: () => ({ ready, reason }), run };
}

function successfulProbe(overrides = {}) {
  return {
    exitCode: 0,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    stdout: HELP,
    stderr: '',
    ...overrides,
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

test('onboarding reports unavailable probes without executing or writing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-onboarding-unavailable-'));
  try {
    const registry = new DeterministicOperationRegistry();
    const service = new ToolOnboarding({
      operationRegistry: registry,
      probe: probe({ ready: false, reason: 'no-route' }),
      manifestDirectory: root,
      entries: [{ command: 'magic-tool', operation: 'tool.magic', helpArgs: ['--help'] }],
    });
    const result = await service.reconcile({ opaque: 'context' });
    assert.deepEqual(result, {
      changed: false,
      events: [{ command: 'magic-tool', operation: 'tool.magic', state: 'probe-unavailable', reason: 'no-route' }],
    });
    assert.equal(registry.has('tool.magic'), false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('onboarding requires an opaque execution context before probing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-onboarding-context-'));
  try {
    const service = new ToolOnboarding({
      operationRegistry: new DeterministicOperationRegistry(),
      probe: probe(),
      manifestDirectory: root,
      entries: [{ command: 'magic-tool', operation: 'tool.magic', helpArgs: ['--help'] }],
    });
    const result = await service.reconcile();
    assert.equal(result.changed, false);
    assert.equal(result.events[0].state, 'probe-context-required');
    assert.match(result.events[0].reason, /exact execution context/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('onboarding passes an opaque context through its neutral probe contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-onboarding-probe-'));
  const calls = [];
  try {
    const registry = new DeterministicOperationRegistry();
    const service = new ToolOnboarding({
      operationRegistry: registry,
      probe: probe({ run: async (request) => { calls.push(request); return successfulProbe(); } }),
      manifestDirectory: root,
      entries: [{ command: 'magic-tool', operation: 'tool.magic', helpArgs: ['--help'] }],
    });
    const context = Object.freeze({ subject: '42', activity: 'run-1' });
    const result = await service.reconcile(context);
    assert.equal(result.changed, true);
    assert.equal(result.events[0].state, 'registered-probed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'tool.magic');
    assert.equal(calls[0].command, 'magic-tool');
    assert.equal(calls[0].context, context);
    assert.equal(registry.has('tool.magic'), true);
    const persisted = JSON.parse(await readFile(path.join(root, 'auto-tool.magic.json'), 'utf8'));
    assert.equal(persisted.executable, 'magic-tool');
    assert.equal(persisted.source.kind, 'help-synthesized');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing control-owned manifest registers without probing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-onboarding-existing-'));
  try {
    const manifest = {
      protocol: LOCAL_OPERATION_MANIFEST_PROTOCOL,
      operation: 'tool.magic',
      executable: 'magic-tool',
      arguments: [{ kind: 'flag', param: 'json', flag: '--json' }],
      requireAnyParameter: true,
      source: { kind: 'help-synthesized', command: 'magic-tool', helpSha256: 'a'.repeat(64) },
    };
    await writeFile(path.join(root, 'auto-tool.magic.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const registry = new DeterministicOperationRegistry();
    const service = new ToolOnboarding({
      operationRegistry: registry,
      probe: probe({ ready: false }),
      manifestDirectory: root,
      entries: [{ command: 'magic-tool', operation: 'tool.magic', helpArgs: ['--help'] }],
    });
    const result = await service.reconcile();
    assert.equal(result.changed, false);
    assert.equal(result.events[0].state, 'registered-existing');
    assert.equal(registry.has('tool.magic'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local onboarding policy rejects command construction and authority-shaped operations', () => {
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
  assert.throws(
    () => validateToolOnboardingPolicy({ autoIntegrate: [{ command: 'one', operation: 'tool.same' }, { command: 'two', operation: 'tool.same' }] }),
    /duplicates operation/u,
  );
});
