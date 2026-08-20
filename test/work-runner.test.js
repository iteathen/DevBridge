import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WorkRunner, workActions } from '../src/runtime/work-runner.js';

const profile = {
  name: 'fixture-action',
  args: ['inspect'],
  inputMode: 'stdin-json',
  timeoutMs: 5_000,
  maxOutputBytes: 64 * 1024,
  environment: { pass: [], set: { FIXTURE: '1' } },
};

test('work actions describe only local result behavior', () => {
  const actions = workActions('r1');
  assert.equal(actions.protocol, 'devbridge/work-actions-v1');
  assert.equal(actions.identity, 'r1');
  assert.deepEqual(actions.result.schema.required, ['protocol', 'status', 'summary']);
  assert.doesNotMatch(JSON.stringify(actions), /gitAuthority|owner|provider|module|resultTransfer|resultFile|host|guest/iu);
});

test('runner works with replaceable input, output, and execution ports', async () => {
  const observed = { input: null, execution: null };
  const runner = new WorkRunner();
  const result = await runner.run({
    profile,
    identity: 'r1',
    context: { objective: 'hello' },
    input: { publish: async (value) => { observed.input = value; } },
    output: { consume: async () => ({ value: '{"protocol":"devbridge/result-v1","status":"complete","summary":"done"}', error: null }) },
    execute: async (request) => {
      observed.execution = request;
      return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(observed.input.objective, 'hello');
  assert.equal(observed.input.actions.identity, 'r1');
  assert.equal(observed.execution.name, 'fixture-action');
  assert.deepEqual(observed.execution.arguments, ['inspect']);
  assert.equal(JSON.parse(observed.execution.payload).objective, 'hello');
  assert.equal(result.result.status, 'complete');
  assert.equal(Object.hasOwn(result, 'execution'), false);
  assert.equal(Object.keys(result).some((name) => /file|path|mailbox|control/iu.test(name)), false);
});

test('recovery consumes only a temporary output port', async () => {
  const recovered = await new WorkRunner().recover({
    output: { consume: async () => ({ value: '{"protocol":"devbridge/result-v1","status":"continue","summary":"recoverable"}', error: null }) },
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.result.status, 'continue');
});

test('runner fails closed on cancellation and malformed port observations', async () => {
  const controller = new AbortController();
  controller.abort(new Error('fenced'));
  await assert.rejects(new WorkRunner().run({ profile, identity: 'r1', context: {}, signal: controller.signal }), /fenced/u);
  await assert.rejects(new WorkRunner().run({
    profile, identity: 'r1', context: {},
    input: { publish: async () => {} },
    output: { consume: async () => ({ value: null, error: null }) },
    execute: async () => ({ exitCode: 0 }),
  }), /timedOut is invalid/u);
});

test('runner source contains no current topology identities', async () => {
  const source = await readFile('src/runtime/work-runner.js', 'utf8');
  assert.doesNotMatch(source, /worker-exchange|repository-execution|repository|workerExchange|mailbox|gitAuthority|controlContextFile|controlResultFile|contextFile|resultFile|provider|guest|host/iu);
});
