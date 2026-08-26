import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWindowsLifecycleAuthorityAcceptanceClient,
  createWindowsLifecycleAuthorityAcceptanceOperator,
  handleWindowsLifecycleAuthorityAcceptanceRequest,
  proveWindowsLifecycleAuthorityAcceptanceDirectMutationDenied,
  verifyWindowsLifecycleAuthorityAcceptance,
  WindowsLifecycleAuthorityAcceptanceFixture,
  WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_REQUEST_PROTOCOL,
  WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_RESULT_PROTOCOL,
} from '../src/setup/windows-lifecycle-authority-acceptance.js';

const SOURCE = fileURLToPath(new URL('../src/setup/windows-lifecycle-authority-acceptance.js', import.meta.url));

function request(operation, extra = {}) {
  return {
    protocol: WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_REQUEST_PROTOCOL,
    requestId: randomUUID(),
    operation,
    ...extra,
  };
}

function generation(operationId) {
  return `acceptance-${createHash('sha256').update(String(operationId)).digest('hex').slice(0, 32)}`;
}

function noOpFence() {
  return Object.freeze({
    async acquire({ environmentIdentity }) {
      return Object.freeze({ subject: environmentIdentity, async release() {} });
    },
  });
}

class FakeFixture {
  current = null;
  effects = [];
  ensureCalls = [];
  retired = [];
  cleaned = 0;
  failAfterFirstEffect = false;
  failed = false;

  async observe() {
    return this.current == null
      ? { state: 'absent', generation: null, diskPath: null }
      : { state: 'ready', generation: this.current, diskPath: `/fixture/${this.current}.vhdx` };
  }

  async ensure({ operationId }) {
    this.ensureCalls.push(operationId);
    const selected = generation(operationId);
    if (!this.effects.includes(selected)) this.effects.push(selected);
    this.current = selected;
    if (this.failAfterFirstEffect && !this.failed) {
      this.failed = true;
      throw new Error('effect committed, response lost');
    }
    return { ready: true, implementationGeneration: selected };
  }

  async retire({ previousImplementationGeneration, implementationGeneration }) {
    assert.equal(this.current, implementationGeneration);
    this.retired.push(previousImplementationGeneration);
    return { ready: true, retired: true };
  }

  async clear() {
    this.current = null;
    this.cleaned += 1;
    return { cleaned: true };
  }
}

async function withTempDirectory(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-acceptance-'));
  try { return await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function operatorFactoryFor(fixture) {
  return (options) => createWindowsLifecycleAuthorityAcceptanceOperator({ ...options, fixture, fence: noOpFence() });
}

test('acceptance exercise uses the existing create and recreate owners for one fixed fixture', async () => withTempDirectory(async (authorityDirectory) => {
  const fixture = new FakeFixture();
  const selected = request('exercise');
  const response = await handleWindowsLifecycleAuthorityAcceptanceRequest({ request: selected, authorityDirectory }, {
    operatorFactory: operatorFactoryFor(fixture),
  });
  assert.equal(response.protocol, WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_RESULT_PROTOCOL);
  assert.equal(response.requestId, selected.requestId);
  assert.equal(response.ok, true);
  assert.equal(response.value.ready, true);
  assert.match(response.value.generation, /^acceptance-[0-9a-f]{32}$/u);
  assert.equal(fixture.effects.length, 2, 'create and recreate must each materialize one exact generation');
  assert.deepEqual(fixture.retired, [fixture.effects[0]]);
  assert.equal(response.value.generation, fixture.effects[1]);
  assert.doesNotMatch(JSON.stringify(response), /fixture\//u);
}));

test('acceptance exercise resumes after an effect committed but its result was lost', async () => withTempDirectory(async (authorityDirectory) => {
  const fixture = new FakeFixture();
  fixture.failAfterFirstEffect = true;
  const first = await handleWindowsLifecycleAuthorityAcceptanceRequest({ request: request('exercise'), authorityDirectory }, {
    operatorFactory: operatorFactoryFor(fixture),
  });
  assert.equal(first.ok, false);
  assert.equal(fixture.effects.length, 1);

  const second = await handleWindowsLifecycleAuthorityAcceptanceRequest({ request: request('exercise'), authorityDirectory }, {
    operatorFactory: operatorFactoryFor(fixture),
  });
  assert.equal(second.ok, true);
  assert.equal(fixture.effects.length, 2, 'resume must not duplicate the already committed create effect');
  assert.equal(fixture.ensureCalls.length, 3, 'the first generation may be re-observed through ensure, but not re-created');
  assert.equal(second.value.generation, fixture.effects[1]);
}));

test('acceptance request rejects caller-selected paths, targets, and provider details before composition', async () => {
  let composed = false;
  for (const extra of [
    { path: 'C:\\foreign\\disk.vhdx' },
    { target: 'foreign-vm' },
    { provider: 'Hyper-V' },
  ]) {
    const response = await handleWindowsLifecycleAuthorityAcceptanceRequest({
      request: request('exercise', extra),
      authorityDirectory: 'C:\\ProgramData\\DevBridge\\authority',
    }, {
      operatorFactory: async () => { composed = true; throw new Error('must not compose'); },
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'ACCEPTANCE_FAILED');
  }
  assert.equal(composed, false);
});

test('acceptance cleanup removes only the dedicated fixture and exact lifecycle state files', async () => withTempDirectory(async (authorityDirectory) => {
  const fixture = new FakeFixture();
  const factory = operatorFactoryFor(fixture);
  const exercise = await handleWindowsLifecycleAuthorityAcceptanceRequest({ request: request('exercise'), authorityDirectory }, { operatorFactory: factory });
  assert.equal(exercise.ok, true);
  const root = path.join(authorityDirectory, 'acceptance');
  await access(path.join(root, 'environment-lifecycle', 'state.json'));
  await access(path.join(root, 'environment-construction', 'state.json'));

  const cleanup = await handleWindowsLifecycleAuthorityAcceptanceRequest({ request: request('cleanup'), authorityDirectory }, { operatorFactory: factory });
  assert.deepEqual(cleanup.value, { cleaned: true });
  assert.equal(fixture.cleaned, 1);
  await assert.rejects(access(path.join(root, 'environment-lifecycle', 'state.json')));
  await assert.rejects(access(path.join(root, 'environment-construction', 'state.json')));
}));

test('acceptance VHDX adapter observes before repeating a planned New-VHD effect', async () => withTempDirectory(async (root) => {
  let createCalls = 0;
  let failFirstCreate = true;
  const invoke = async (call) => {
    const script = Buffer.from(call.arguments.at(-1), 'base64').toString('utf16le');
    const input = JSON.parse(call.input);
    if (script.includes('New-VHD')) {
      createCalls += 1;
      await writeFile(input.path, 'fixture');
      if (failFirstCreate) {
        failFirstCreate = false;
        return { exitCode: 1, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: 'lost result' };
      }
      return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"ready":true,"diskIdentity":"disk-1"}\n', stderr: '' };
    }
    return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"exists":true,"ready":true,"diskIdentity":"disk-1"}\n', stderr: '' };
  };
  const fixture = new WindowsLifecycleAuthorityAcceptanceFixture({ root, invoke, environment: {} });
  await assert.rejects(fixture.ensure({ operationId: 'operation-a' }), /creation failed/u);
  const resumed = await fixture.ensure({ operationId: 'operation-a' });
  assert.equal(resumed.ready, true);
  assert.equal(createCalls, 1, 'an observed VHDX must not be recreated after an ambiguous result');
  const observed = await fixture.observe();
  assert.equal(observed.state, 'ready');
  assert.equal(observed.generation, resumed.implementationGeneration);
}));

test('ordinary direct acceptance probes require access-denied results for replace and delete', async () => {
  const calls = [];
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  const result = await proveWindowsLifecycleAuthorityAcceptanceDirectMutationDenied('C:\\protected\\fixture.vhdx', {
    renameFile: async (from, to) => { calls.push(['rename', from, to]); throw denied; },
    unlinkFile: async (target) => { calls.push(['unlink', target]); throw denied; },
  });
  assert.equal(result.ready, true);
  assert.equal(calls.length, 2);
  await assert.rejects(
    proveWindowsLifecycleAuthorityAcceptanceDirectMutationDenied('C:\\protected\\fixture.vhdx', {
      renameFile: async () => {},
      unlinkFile: async () => { throw denied; },
    }),
    /replacement was not denied/u,
  );
});

test('parent acceptance verifier always cleans the disposable fixture and exposes no mutation pipe', async () => {
  const calls = [];
  const client = {
    async exercise() { calls.push('exercise'); return { ready: true, generation: `acceptance-${'a'.repeat(32)}` }; },
    async cleanup() { calls.push('cleanup'); return { cleaned: true }; },
  };
  const result = await verifyWindowsLifecycleAuthorityAcceptance({ authorityDirectory: 'authority', endpoint: 'acceptance-pipe' }, {
    clientFactory: () => client,
    diskPathFor: ({ generation: selected }) => `/derived/${selected}.vhdx`,
    directMutationDenied: async (target) => { calls.push(['deny', target]); },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(calls, [
    'exercise',
    ['deny', `/derived/acceptance-${'a'.repeat(32)}.vhdx`],
    'cleanup',
  ]);

  calls.length = 0;
  await assert.rejects(
    verifyWindowsLifecycleAuthorityAcceptance({ authorityDirectory: 'authority', endpoint: 'acceptance-pipe' }, {
      clientFactory: () => client,
      diskPathFor: () => '/derived/fixture.vhdx',
      directMutationDenied: async () => { throw new Error('ordinary write allowed'); },
    }),
    /ordinary write allowed/u,
  );
  assert.deepEqual(calls, ['exercise', 'cleanup']);
});

test('acceptance client wire contract has only operation identity and no caller-selected subject', async () => {
  let captured = null;
  const client = createWindowsLifecycleAuthorityAcceptanceClient({ endpoint: 'pipe' }, {
    exchangeFactory: () => async (requestValue) => {
      captured = requestValue;
      return {
        protocol: WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_RESULT_PROTOCOL,
        requestId: requestValue.requestId,
        ok: true,
        value: { ready: true, generation: `acceptance-${'b'.repeat(32)}` },
      };
    },
  });
  const value = await client.exercise();
  assert.equal(value.ready, true);
  assert.deepEqual(Object.keys(captured).sort(), ['operation', 'protocol', 'requestId']);
  assert.equal(captured.operation, 'exercise');
});

test('acceptance provider is VHDX-only and contains no VM or production construction primitive', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.equal(source.includes('New-VHD'), true);
  for (const forbidden of ['New-VM', 'Remove-VM', 'Start-VM', 'Stop-VM', '--construct']) {
    assert.equal(source.includes(forbidden), false, `acceptance fixture leaked ${forbidden}`);
  }
});
