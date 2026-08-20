import test from 'node:test';
import assert from 'node:assert/strict';

async function loadRepositoryStuds(t) {
  try { return await import('../src/runtime/repository-execution.js'); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') { t.skip('focused Stage 4 harness omits unchanged Stage 1 source; full repository CI exercises this test'); return null; }
    throw error;
  }
}

function locationFor(transfer) {
  return { class: transfer.direction === 'input' ? 'input' : 'output', path: `ports/${transfer.name}` };
}

async function throughBridge(studs, request, bridge, target, resolveProgram) {
  const normalized = studs.normalizeRepositoryExecutionRequest(request);
  const byName = new Map(normalized.transfers.map((transfer) => [transfer.name, transfer]));
  for (const transfer of normalized.transfers) {
    if (transfer.direction === 'input') await bridge.put(target, transfer.port, locationFor(transfer));
  }
  const selected = resolveProgram(normalized.invocation.tool);
  const argumentsList = [
    ...(selected.arguments ?? []),
    ...normalized.invocation.arguments.map((argument) => argument.kind === 'literal' ? argument.value : locationFor(byName.get(argument.name))),
  ];
  const outcome = await bridge.execute(target, {
    program: selected.program,
    arguments: argumentsList,
    directory: { class: 'work', path: normalized.invocation.workingDirectory },
    environment: normalized.environment,
    input: normalized.stdin,
    timeoutMs: normalized.limits.timeoutMs,
    maxOutputBytes: Math.min(normalized.limits.maxOutputBytes, 3 * 1024 * 1024),
  }, { signal: normalized.signal, onActivity: normalized.onActivity });
  if (outcome.completion !== 'observed') throw new Error('test attachment requires an observed bridge completion');
  for (const transfer of normalized.transfers) {
    if (transfer.direction === 'output') await bridge.get(target, locationFor(transfer), transfer.port);
  }
  return studs.normalizeRepositoryExecutionResult({
    protocol: studs.REPOSITORY_EXECUTION_RESULT_PROTOCOL,
    ...outcome.result,
    evidence: { identity: `bridge-${outcome.request}`, scope: normalized.scope },
  });
}

test('Stage 4 can attach behind the unchanged Stage 1 execution/input/result studs without production routing', async (t) => {
  const studs = await loadRepositoryStuds(t);
  if (!studs) return;
  const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const inputBytes = Buffer.from('input');
  let inputRead = false;
  let output = null;
  const calls = [];
  const bridge = {
    async put(receivedTarget, port, destination) {
      calls.push(['put', receivedTarget, destination]);
      const part = await port.read({ offset: 0, limit: 1024 });
      assert.deepEqual(Buffer.from(part.data), inputBytes);
    },
    async execute(receivedTarget, operation) {
      calls.push(['execute', receivedTarget, operation]);
      assert.equal(operation.program, 'node');
      assert.deepEqual(operation.arguments.slice(-2), [{ class: 'input', path: 'ports/source' }, { class: 'output', path: 'ports/result' }]);
      return {
        completion: 'observed', request: 'f'.repeat(32), target: receivedTarget,
        result: { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: 'ok', stderr: '', startedAt: null, finishedAt: null, lastOutputAt: null },
      };
    },
    async get(receivedTarget, source, port) {
      calls.push(['get', receivedTarget, source]);
      await port.write({ offset: 0, data: Buffer.from('output'), eof: true, digest: '0'.repeat(64) });
    },
  };
  const request = {
    protocol: studs.REPOSITORY_EXECUTION_REQUEST_PROTOCOL,
    operation: 'test.operation',
    scope: { repository: 'owner/project', repositoryId: '123', runId: 'run-1' },
    invocation: { tool: 'logical.test', arguments: [{ kind: 'input', name: 'source' }, { kind: 'output', name: 'result' }], workingDirectory: '.' },
    environment: {},
    transfers: [
      { name: 'source', direction: 'input', port: { async read() { assert.equal(inputRead, false); inputRead = true; return { data: inputBytes, eof: true }; } } },
      { name: 'result', direction: 'output', port: { async write(entry) { output = Buffer.from(entry.data).toString('utf8'); } } },
    ],
    limits: { timeoutMs: 5_000, maxOutputBytes: 4096 }, stdin: null, signal: null, onActivity: null,
  };
  const result = await throughBridge(studs, request, bridge, target, (tool) => {
    assert.equal(tool, 'logical.test');
    return { program: 'node', arguments: [] };
  });
  assert.equal(result.protocol, studs.REPOSITORY_EXECUTION_RESULT_PROTOCOL);
  assert.equal(result.stdout, 'ok');
  assert.equal(output, 'output');
  assert.deepEqual(calls.map((entry) => entry[0]), ['put', 'execute', 'get']);
});
