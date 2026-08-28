import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  WindowsProductionQualification,
} from '../src/runtime/image-builders/windows-production-qualification.js';

const TARGET = `subject-${'1'.repeat(32)}`;
const FIRST_BOOT = '2026-08-28T10:00:00.000Z';
const SECOND_BOOT = '2026-08-28T10:10:00.000Z';
const EXPECTED = Object.freeze({
  build: 26100,
  edition: 'Professional',
  architecture: 'amd64',
  installationType: 'Client',
  defaultLanguage: 'en-US',
  authorityGeneration: 'windows-build-basics-20260828-v2',
  payloadGeneration: 'windows-guest-payload-v1',
  nodeVersion: '22.23.2',
  sourceControlVersion: '2.55.0.windows.5',
  nativeBuildVersion: '17.14.37614.0',
});

function memoryJournal() {
  const values = new Map();
  let failPhase = null;
  return {
    async load(identity) { return values.has(identity) ? structuredClone(values.get(identity)) : undefined; },
    async save(identity, value) {
      if (value.phase === failPhase) {
        failPhase = null;
        throw new Error(`simulated ${value.phase} checkpoint loss`);
      }
      values.set(identity, structuredClone(value));
    },
    failOn(phase) { failPhase = phase; },
  };
}

function qualificationResult(overrides = {}) {
  return {
    protocol: 'devbridge/windows-production-qualification-v1',
    os: '10.0.26100',
    build: '26100',
    edition: 'Professional',
    architecture: 'amd64',
    installationType: 'Client',
    language: 'en-US',
    bootIdentity: SECOND_BOOT,
    node: 'v22.23.2',
    npm: '10.9.3',
    sourceControl: 'git version 2.55.0.windows.5',
    nativeBuild: '17.14.37614.0',
    cmake: 'cmake version 3.31.6-msvc1',
    compiler: '19.44.35222.0',
    authorityGeneration: 'windows-build-basics-20260828-v2',
    payloadGeneration: 'windows-guest-payload-v1',
    network: true,
    cmakeCtest: true,
    services: true,
    ...overrides,
  };
}

function harness({ journal = memoryJournal(), qualify = qualificationResult(), statusBoots = [SECOND_BOOT], finalStates = ['off'] } = {}) {
  const calls = [];
  const boots = [...statusBoots];
  const states = [...finalStates];
  const operations = {
    async execute(request) {
      calls.push(structuredClone(request));
      if (request.operation === 'prepare-v1') return {
        prepared: true,
        generation: EXPECTED.authorityGeneration,
        payloadGeneration: EXPECTED.payloadGeneration,
        nativeBuildVersion: EXPECTED.nativeBuildVersion,
        bootIdentity: FIRST_BOOT,
        restartRequired: true,
      };
      if (request.operation === 'restart-v1') return { scheduled: true };
      if (request.operation === 'status-v1') return {
        protocol: 'devbridge/windows-production-status-v1',
        bootIdentity: boots.length > 1 ? boots.shift() : boots[0],
        ready: true,
      };
      if (request.operation === 'qualify-v1') {
        if (qualify instanceof Error) throw qualify;
        return structuredClone(qualify);
      }
      if (request.operation === 'finalize-v1') return { scheduled: true, processId: 42 };
      throw new Error('unexpected operation');
    },
  };
  const observe = async (identity) => ({ identity, exists: true, owned: true, state: states.length > 1 ? states.shift() : states[0] });
  const qualifier = () => new WindowsProductionQualification({ journal, operations, observe, sleep: async () => {}, pollMs: 10 });
  return { journal, calls, qualifier };
}

test('Windows production probe durably prepares, proves a reboot, and qualifies the exact image contract', async () => {
  const parts = harness({ statusBoots: [FIRST_BOOT, SECOND_BOOT] });
  const evidence = await parts.qualifier().probe({ target: TARGET, expected: EXPECTED });
  assert.equal(evidence.source.build, 26100);
  assert.equal(evidence.source.edition, 'Professional');
  assert.equal(evidence.tools.node, 'v22.23.2');
  assert.equal(evidence.tools.sourceControl, 'git version 2.55.0.windows.5');
  assert.equal(evidence.tools.nativeBuild, '17.14.37614.0');
  assert.equal(evidence.bootIdentity, SECOND_BOOT);
  assert.equal(evidence.restarted, true);
  assert.equal(evidence.sanitized, false);
  assert.deepEqual(parts.calls.map(({ operation }) => operation), ['prepare-v1', 'restart-v1', 'status-v1', 'status-v1', 'qualify-v1']);

  const replayed = await parts.qualifier().probe({ target: TARGET, expected: EXPECTED });
  assert.deepEqual(replayed, evidence);
  assert.equal(parts.calls.filter(({ operation }) => operation === 'prepare-v1').length, 1);
  assert.equal(parts.calls.filter(({ operation }) => operation === 'restart-v1').length, 1);
});

test('Windows production probe reconciles a completed restart whose receipt checkpoint was interrupted', async () => {
  const journal = memoryJournal();
  journal.failOn('restart-requested');
  const parts = harness({ journal });
  await assert.rejects(() => parts.qualifier().probe({ target: TARGET, expected: EXPECTED }), /simulated restart-requested checkpoint loss/u);
  assert.equal(parts.calls.filter(({ operation }) => operation === 'restart-v1').length, 1);

  const evidence = await parts.qualifier().probe({ target: TARGET, expected: EXPECTED });
  assert.equal(evidence.restarted, true);
  assert.equal(parts.calls.filter(({ operation }) => operation === 'restart-v1').length, 1, 'an ambiguous restart must not be replayed');
});

test('Windows production probe rejects authority drift and forged guest evidence before finalization', async () => {
  const invalidExpectation = harness();
  await assert.rejects(() => invalidExpectation.qualifier().probe({ target: TARGET, expected: { ...EXPECTED, command: 'anything' } }), /command is not allowed/u);
  assert.equal(invalidExpectation.calls.length, 0);

  const forged = harness({ qualify: qualificationResult({ build: '22631' }) });
  await assert.rejects(() => forged.qualifier().probe({ target: TARGET, expected: EXPECTED }), /does not match the required image contract/u);
  assert.equal(forged.calls.some(({ operation }) => operation === 'finalize-v1'), false);

  const mutableSuite = harness({ qualify: qualificationResult({ nativeBuild: '17.14.37531.7' }) });
  await assert.rejects(() => mutableSuite.qualifier().probe({ target: TARGET, expected: EXPECTED }), /does not match the required image contract/u);
  assert.equal(mutableSuite.calls.some(({ operation }) => operation === 'finalize-v1'), false);
});

test('Windows production finalization is planned before effect, waits for shutdown, and is idempotent after receipt', async () => {
  const parts = harness({ finalStates: ['running', 'off'] });
  await parts.qualifier().probe({ target: TARGET, expected: EXPECTED });
  const result = await parts.qualifier().finalize(TARGET);
  assert.deepEqual(result, { protocol: 'devbridge/windows-production-finalization-v1', finalized: true, sanitized: true });
  assert.equal(parts.calls.filter(({ operation }) => operation === 'finalize-v1').length, 1);
  assert.deepEqual(await parts.qualifier().finalize(TARGET), result);
  assert.equal(parts.calls.filter(({ operation }) => operation === 'finalize-v1').length, 1);
});

test('Windows production finalization never replays an effect whose receipt checkpoint was interrupted', async () => {
  const journal = memoryJournal();
  const parts = harness({ journal });
  await parts.qualifier().probe({ target: TARGET, expected: EXPECTED });
  journal.failOn('finalization-requested');
  await assert.rejects(() => parts.qualifier().finalize(TARGET), /simulated finalization-requested checkpoint loss/u);
  await assert.rejects(() => parts.qualifier().finalize(TARGET), /ambiguous and cannot be replayed/u);
  assert.equal(parts.calls.filter(({ operation }) => operation === 'finalize-v1').length, 1);
});

test('Windows production qualification owns no provider, repository, or neighboring-module topology', async () => {
  const source = await readFile(new URL('../src/runtime/image-builders/windows-production-qualification.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /HyperV|libvirt|GitHub|repository[A-Z]|branch|pull request|Codex|CUDA/iu);
});
