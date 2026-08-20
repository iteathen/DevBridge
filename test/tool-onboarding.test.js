import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOnboardingRecordPort } from '../src/app/tool-onboarding-composition.js';
import { DeterministicOperationRegistry } from '../src/runtime/deterministic-operation-registry.js';
import { parseCliHelp } from '../src/runtime/cli-help-parser.js';
import { ToolOnboarding } from '../src/runtime/tool-onboarding.js';
import { validateToolOnboardingPolicy } from '../src/runtime/tool-onboarding-policy.js';

const HELP = `Usage: magic-tool [OPTIONS] <INPUT>\n\nOptions:\n  --json                 Emit JSON\n  --jobs <COUNT>         Worker count\n  --output <PATH>        Project output path\n  --env <VALUE>          Dangerous authority-like parameter\n  --mode <WHEN>          Mode\n`;
const ENTRY = Object.freeze({ command: 'magic-tool', operation: 'tool.magic', helpArgs: Object.freeze(['--help']) });

function probe({ ready = true, reason = null, run = async () => { throw new Error('probe must not run'); } } = {}) {
  return { inspect: () => ({ ready, reason }), run };
}

function observation(overrides = {}) {
  return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: HELP, stderr: '', ...overrides };
}

function records(overrides = {}) {
  return { restore: async () => null, has: () => false, publish: async () => {}, ...overrides };
}

test('help parser synthesizes only bounded safe flags, options, and positionals', () => {
  const parsed = parseCliHelp(HELP);
  assert.match(parsed.helpSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(parsed.arguments, [
    { kind: 'flag', param: 'json', flag: '--json' },
    { kind: 'option', param: 'jobs', flag: '--jobs', required: false, repeat: false, valueType: 'integer' },
    { kind: 'option', param: 'output', flag: '--output', required: false, repeat: false, valueType: 'project-path' },
    { kind: 'option', param: 'mode', flag: '--mode', required: false, repeat: false, valueType: 'string' },
    { kind: 'positional', param: 'input', required: true, repeat: false, valueType: 'string' },
  ]);
  assert.equal(parsed.arguments.some((entry) => entry.param === 'env'), false);
});

test('onboarding reports an unavailable temporary probe without publishing', async () => {
  let published = false;
  const onboarding = new ToolOnboarding({ entries: [ENTRY] });
  const result = await onboarding.reconcile({
    context: Object.freeze({ opaque: 'value' }),
    probe: probe({ ready: false, reason: 'no-route' }),
    records: records({ publish: async () => { published = true; } }),
  });
  assert.deepEqual(result, { changed: false, events: [{ command: 'magic-tool', operation: 'tool.magic', state: 'probe-unavailable', reason: 'no-route' }] });
  assert.equal(published, false);
});

test('onboarding requires and passes through an opaque context', async () => {
  const onboarding = new ToolOnboarding({ entries: [ENTRY] });
  const missing = await onboarding.reconcile({ probe: probe(), records: records() });
  assert.equal(missing.events[0].state, 'probe-context-required');

  const calls = [];
  const publications = [];
  const context = Object.freeze({ subject: '42', activity: 'run-1' });
  const result = await onboarding.reconcile({
    context,
    probe: probe({ run: async (request) => { calls.push(request); return observation(); } }),
    records: records({ publish: async (value) => { publications.push(value); } }),
  });
  assert.equal(result.changed, true);
  assert.equal(result.events[0].state, 'available-probed');
  assert.equal(calls[0].context, context);
  assert.equal(calls[0].command, 'magic-tool');
  assert.deepEqual(publications[0].entry, ENTRY);
  assert.match(publications[0].parsed.helpSha256, /^[0-9a-f]{64}$/u);
});

test('failed, timed-out, and truncated observations never publish', async () => {
  for (const failed of [
    observation({ exitCode: 2, stderr: 'bad' }),
    observation({ timedOut: true }),
    observation({ outputTruncated: true }),
  ]) {
    let published = false;
    const result = await new ToolOnboarding({ entries: [ENTRY] }).reconcile({
      context: {},
      probe: probe({ run: async () => failed }),
      records: records({ publish: async () => { published = true; } }),
    });
    assert.equal(result.events[0].state, 'probe-failed');
    assert.equal(published, false);
  }
});

test('composition persists before activation and restores the record after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'db-onboarding-records-'));
  const file = path.join(directory, 'auto-tool.magic.json');
  try {
    const base = new DeterministicOperationRegistry();
    const guarded = {
      has: (name) => base.has(name),
      register(name, adapter) {
        assert.equal(existsSync(file), true, 'activation must follow durable persistence');
        base.register(name, adapter);
      },
    };
    const first = new ToolOnboarding({ entries: [ENTRY] });
    const result = await first.reconcile({
      context: {},
      probe: probe({ run: async () => observation() }),
      records: createOnboardingRecordPort({ directory, operationRegistry: guarded }),
    });
    assert.equal(result.changed, true);
    assert.equal(base.has('tool.magic'), true);
    assert.deepEqual(await readdir(directory), ['auto-tool.magic.json']);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.source.command, 'magic-tool');

    const restarted = new DeterministicOperationRegistry();
    const restored = await new ToolOnboarding({ entries: [ENTRY] }).reconcile({
      probe: probe({ ready: false }),
      records: createOnboardingRecordPort({ directory, operationRegistry: restarted }),
    });
    assert.equal(restored.changed, false);
    assert.equal(restored.events[0].state, 'available-existing');
    assert.equal(restarted.has('tool.magic'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('policy rejects command construction and authority-shaped operations', () => {
  assert.throws(() => validateToolOnboardingPolicy({ autoIntegrate: [{ command: 'tool;rm' }] }), /command is invalid/u);
  assert.throws(() => validateToolOnboardingPolicy({ autoIntegrate: [{ command: 'tool', helpArgs: ['help;rm'] }] }), /fixed safe option/u);
  assert.throws(() => validateToolOnboardingPolicy({ autoIntegrate: [{ command: 'tool', operation: 'shell.exec' }] }), /operation is invalid/u);
  assert.throws(() => validateToolOnboardingPolicy({ autoIntegrate: [{ command: 'one', operation: 'tool.same' }, { command: 'two', operation: 'tool.same' }] }), /duplicates operation/u);
});

test('isolated onboarding bricks cannot acquire topology dependencies', async () => {
  const restrictions = new Map([
    ['src/runtime/cli-help-parser.js', /node:fs|registry|repository|provider|topology|manifest/iu],
    ['src/runtime/tool-onboarding-policy.js', /node:fs|probe|persist|composition|registry|repository|provider|topology|manifest/iu],
    ['src/runtime/tool-onboarding.js', /node:fs|local-operation-manifest|repository-execution|operationRegistry|manifestDirectory|workspaceRoot|repository|provider|topology/iu],
  ]);
  for (const [file, forbidden] of restrictions) assert.doesNotMatch(await readFile(file, 'utf8'), forbidden, file);
});
