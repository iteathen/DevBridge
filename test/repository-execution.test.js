import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
  REPOSITORY_EXECUTION_RESULT_PROTOCOL,
  REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  UnavailableRepositoryExecution,
  assertRepositoryExecutionContract,
  normalizeRepositoryExecutionRequest,
  normalizeRepositoryExecutionResult,
  normalizeRepositoryExecutionStatus,
} from '../src/runtime/repository-execution.js';

function ports() {
  const writes = [];
  return {
    writes,
    context: { async read() { return Buffer.from('{"objective":"fixture"}\n'); } },
    result: { async write(value) { writes.push(Buffer.from(value)); } },
  };
}

function request(overrides = {}, transferPorts = ports()) {
  return {
    protocol: REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
    operation: 'fixture.run',
    scope: { repository: 'owner/project', repositoryId: '12345', runId: 'run-1' },
    invocation: {
      tool: 'fixture-tool',
      arguments: ['--context', { kind: 'input', name: 'context' }, '--result', { kind: 'output', name: 'result' }],
      workingDirectory: '.',
    },
    environment: { CI: '1' },
    transfers: [
      { name: 'context', direction: 'input', port: transferPorts.context },
      { name: 'result', direction: 'output', port: transferPorts.result },
    ],
    limits: { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
    stdin: null,
    ...overrides,
  };
}

test('request vocabulary is execution-owned and uses logical tool/transfer references', () => {
  const normalized = normalizeRepositoryExecutionRequest(request());
  assert.equal(normalized.operation, 'fixture.run');
  assert.deepEqual(normalized.scope, { repository: 'owner/project', repositoryId: '12345', runId: 'run-1' });
  assert.equal(normalized.invocation.tool, 'fixture-tool');
  assert.deepEqual(normalized.invocation.arguments[1], { kind: 'input', name: 'context' });
  assert.deepEqual(normalized.invocation.arguments[3], { kind: 'output', name: 'result' });
  assert.equal(normalized.transfers[0].direction, 'input');
  assert.equal(normalized.transfers[1].direction, 'output');
  for (const foreign of ['sandbox', 'vm', 'workerExchange', 'sourceRoot', 'executable']) {
    assert.equal(Object.hasOwn(normalized, foreign), false);
  }
});

test('request carries neutral capability requirements without provider authority', () => {
  const normalized = normalizeRepositoryExecutionRequest(request({
    scope: {
      repository: 'owner/project',
      repositoryId: '12345',
      runId: 'run-1',
      requestedCapabilities: ['project.write', 'profile:linux', 'profile:cuda', 'profile:cuda'],
    },
  }));
  assert.deepEqual(normalized.scope.requestedCapabilities, ['project.write', 'profile:linux', 'profile:cuda']);
  assert.doesNotMatch(JSON.stringify(normalized.scope), /pci|hyper|vsock|devicePath/iu);
  assert.throws(() => normalizeRepositoryExecutionRequest(request({
    scope: {
      repository: 'owner/project',
      repositoryId: '12345',
      runId: 'run-1',
      requestedCapabilities: ['bad capability'],
    },
  })), /requestedCapabilities\[0\]/u);
});

test('request rejects foreign boundary vocabulary rather than retaining a neighbor dependency', () => {
  for (const [key, value] of [['sandbox', { required: true }], ['vm', { name: 'fixture' }], ['workerExchange', {}]]) {
    assert.throws(() => normalizeRepositoryExecutionRequest({ ...request(), [key]: value }), new RegExp(`repository execution request\\.${key} is not allowed`, 'u'));
  }
});

test('invocation rejects host-path-shaped tool identity and working-directory traversal', () => {
  assert.throws(() => normalizeRepositoryExecutionRequest(request({ invocation: { tool: '/usr/bin/node', arguments: [], workingDirectory: '.' } })), /logical tool identity/u);
  assert.throws(() => normalizeRepositoryExecutionRequest(request({ invocation: { tool: 'node', arguments: [], workingDirectory: '../host' } })), /traversal/u);
});

test('transfer argument references are checked against execution-owned transfer declarations', () => {
  const malformed = request({ invocation: { tool: 'fixture-tool', arguments: [{ kind: 'output', name: 'context' }], workingDirectory: '.' } });
  assert.throws(() => normalizeRepositoryExecutionRequest(malformed), /direction does not match output/u);
});

test('the execution contract rejects credential-shaped environment inputs', () => {
  for (const name of ['GITHUB_TOKEN', 'API_KEY', 'AWS_ACCESS_KEY_ID', 'SERVICE_PASSWORD', 'SSH_AUTH_SOCK', 'GIT_ASKPASS']) {
    assert.throws(() => normalizeRepositoryExecutionRequest(request({ environment: { [name]: 'not-admitted' } })), /reserved by the execution boundary/u);
  }
  assert.deepEqual(normalizeRepositoryExecutionRequest(request({ environment: { CI: '1', DEVBRIDGE_RUN_ID: 'run-1' } })).environment, {
    CI: '1', DEVBRIDGE_RUN_ID: 'run-1',
  });
});

test('transfers depend on read/write ports rather than a filesystem transport', () => {
  const badInput = request();
  badInput.transfers[0] = { name: 'context', direction: 'input', port: { path: '/tmp/context.json' } };
  assert.throws(() => normalizeRepositoryExecutionRequest(badInput), /input transfer context must provide read\(\)/u);
});

test('no-implementation state is explicit, provider-neutral, and fail-closed', async () => {
  const execution = new UnavailableRepositoryExecution();
  assertRepositoryExecutionContract(execution);
  assert.deepEqual(execution.inspect(), {
    protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
    state: 'unavailable', ready: false, identity: null,
    reason: 'no repository execution implementation is configured',
  });
  await assert.rejects(() => execution.execute(request()), /repository execution is unavailable/u);
});

test('status normalization does not expose provider-specific shape', () => {
  const status = normalizeRepositoryExecutionStatus({
    protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
    state: 'ready', ready: true, identity: 'fixture', reason: null,
  });
  assert.equal(status.identity, 'fixture');
  assert.equal(Object.hasOwn(status, 'provider'), false);
  assert.equal(Object.hasOwn(status, 'hyperV'), false);
  assert.equal(Object.hasOwn(status, 'libvirt'), false);
});

test('a fake implementation fits the stud and can exercise transfer ports', async () => {
  const seen = [];
  const fake = assertRepositoryExecutionContract({
    inspect() { return { protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL, state: 'ready', ready: true, identity: 'fixture', reason: null }; },
    async execute(raw) {
      const normalized = normalizeRepositoryExecutionRequest(raw);
      seen.push(normalized);
      const input = normalized.transfers.find((transfer) => transfer.name === 'context');
      const output = normalized.transfers.find((transfer) => transfer.name === 'result');
      const context = await input.port.read();
      await output.port.write(Buffer.from(`observed:${context.length}`));
      return normalizeRepositoryExecutionResult({
        protocol: REPOSITORY_EXECUTION_RESULT_PROTOCOL,
        exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false,
        stdout: 'ok\n', stderr: '', startedAt: null, finishedAt: null, lastOutputAt: null,
        evidence: { identity: 'fixture', scope: normalized.scope },
      });
    },
  });
  const transferPorts = ports();
  const result = await fake.execute(request({}, transferPorts));
  assert.equal(result.exitCode, 0);
  assert.equal(seen[0].invocation.tool, 'fixture-tool');
  assert.equal(transferPorts.writes.length, 1);
  assert.match(transferPorts.writes[0].toString('utf8'), /^observed:/u);
});
