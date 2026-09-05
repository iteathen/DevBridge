import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseRepositoryPreflightArguments,
  runRepositoryPreflight,
} from '../src/bootstrap/repository-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function successfulRunner(calls) {
  return (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('preflight arguments expose only closed scheduling and qualification selections', () => {
  assert.deepEqual(parseRepositoryPreflightArguments([]), { boundTargetedTestConcurrency: false, ciQualification: false });
  assert.deepEqual(parseRepositoryPreflightArguments(['--bound-targeted-test-concurrency']), { boundTargetedTestConcurrency: true, ciQualification: false });
  assert.throws(() => parseRepositoryPreflightArguments('--bound-targeted-test-concurrency'), /must be an array/u);
  assert.throws(() => parseRepositoryPreflightArguments(['--bound-targeted-test-concurrency=1']), /accepts only/u);
  assert.throws(() => parseRepositoryPreflightArguments(['--bound-targeted-test-concurrency', '--bound-targeted-test-concurrency']), /accepts only/u);
  assert.throws(() => parseRepositoryPreflightArguments(['--serialize-targeted-tests']), /accepts only/u);
  assert.throws(() => parseRepositoryPreflightArguments(['--test-concurrency=8']), /accepts only/u);
});

test('bounded scheduling changes only the complete targeted-test runner invocation', () => {
  const ordinaryCalls = [];
  const ordinary = runRepositoryPreflight(root, successfulRunner(ordinaryCalls), {}, {});
  const ordinaryTestCalls = ordinaryCalls.filter(({ args }) => args[0] === '--test');
  assert.equal(ordinaryTestCalls.length, 1);
  assert.equal(ordinaryTestCalls[0].args[1], 'test/standalone-artifact.test.js');
  assert.doesNotMatch(ordinaryTestCalls[0].args.join(' '), /test-concurrency/u);

  const boundedCalls = [];
  const bounded = runRepositoryPreflight(root, successfulRunner(boundedCalls), {}, { boundTargetedTestConcurrency: true });
  const boundedTestCalls = boundedCalls.filter(({ args }) => args[0] === '--test');
  assert.equal(boundedTestCalls.length, 1);
  assert.deepEqual(boundedTestCalls[0].args.slice(0, 3), [
    '--test',
    '--test-concurrency=2',
    'test/standalone-artifact.test.js',
  ]);
  assert.equal(bounded.targetedTests, ordinary.targetedTests);
  assert.equal(boundedTestCalls[0].args.length, ordinaryTestCalls[0].args.length + 1);
});

test('programmatic preflight scheduling rejects open or malformed options before work', () => {
  assert.throws(
    () => runRepositoryPreflight(root, successfulRunner([]), {}, { testFileConcurrency: 8 }),
    /unsupported field/u,
  );
  assert.throws(
    () => runRepositoryPreflight(root, successfulRunner([]), {}, { boundTargetedTestConcurrency: 'yes' }),
    /must be boolean/u,
  );
  assert.throws(
    () => runRepositoryPreflight(root, successfulRunner([]), {}, null),
    /must be an object/u,
  );
});

test('CI qualification is explicit, finite, independent of scheduling and does not alter inventory', () => {
  for (const args of [['--ci-qualification'], ['--ci-qualification', '--bound-targeted-test-concurrency'],
    ['--bound-targeted-test-concurrency', '--ci-qualification']]) {
    const options = parseRepositoryPreflightArguments(args);
    const calls = [];
    const events = [];
    const result = runRepositoryPreflight(root, successfulRunner(calls), {}, options, {
      now: () => 0, onProgress: (event) => events.push(event),
    });
    assert.equal(result.targetedTests, 234);
    assert.equal(events[0].remainingMs, 360_000);
    assert.equal(calls.at(-1).options.timeout, 300_000);
    assert.equal(calls.at(-1).args.includes('--test-concurrency=2'), args.length === 2);
  }
  assert.throws(() => parseRepositoryPreflightArguments(['--ci-qualification', '--ci-qualification']), /at most once/u);
  assert.throws(() => parseRepositoryPreflightArguments(['--ci-qualification=900000']), /accepts only/u);
  assert.throws(() => runRepositoryPreflight(root, successfulRunner([]), {}, { ciQualification: 'yes' }), /must be boolean/u);
});

test('preflight emits operation evidence before work and does not renew its aggregate budget', () => {
  let time = 0;
  const events = [];
  const calls = [];
  const runner = (executable, args, options) => {
    assert.equal(events.at(-1)?.status, 'started');
    calls.push({ args, options });
    time += args[0] === '--test' ? 170_000 : 100;
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = runRepositoryPreflight(root, runner, {}, {}, {
    now: () => time, onProgress: (event) => events.push(event),
  });
  assert.equal(result.targetedTests, 234);
  assert.equal(events[0].remainingMs, 210_000);
  assert.equal(events.at(-1).status, 'passed');
  assert.ok(events.at(-1).remainingMs < 20_000);
  assert.ok(events.every((event) => !JSON.stringify(event).includes(root)));
  const targeted = calls.at(-1);
  assert.equal(targeted.options.timeout, 180_000);
  assert.deepEqual(targeted.options.stdio, ['ignore', 'inherit', 'pipe']);
  assert.ok(targeted.args.includes('--test-reporter=./src/bootstrap/preflight-progress-reporter.mjs'));
  assert.ok(targeted.args.includes('--test-reporter=tap'));
  assert.ok(targeted.args.includes('--test-reporter-destination=stdout'));
  assert.ok(targeted.args.includes('--test-reporter-destination=stderr'));
});

test('aggregate deadline clips child allowance and rejects a late success without later work', () => {
  let time = 0;
  const timeouts = [];
  const events = [];
  const runner = (_executable, _args, options) => {
    timeouts.push(options.timeout);
    time += 60_000;
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(() => runRepositoryPreflight(root, runner, {}, {}, {
    now: () => time, onProgress: (event) => events.push(event),
  }), (error) => error.code === 'ETIMEDOUT');
  assert.deepEqual(timeouts, [60_000, 60_000, 60_000, 30_000]);
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(events.at(-1).outcome, 'timeout');
});

test('preflight rejects elapsed admission and invalid observation ports before spawning', () => {
  let calls = 0;
  const runner = () => { calls += 1; return { status: 0 }; };
  let reads = 0;
  assert.throws(() => runRepositoryPreflight(root, runner, {}, {}, {
    now: () => reads++ === 0 ? 0 : 210_000,
  }), (error) => error.code === 'ETIMEDOUT');
  for (const observation of [{ now: 1 }, { onProgress: 1 }, { timeoutMs: 900_000 }]) {
    assert.throws(() => runRepositoryPreflight(root, runner, {}, {}, observation), /observation/u);
  }
  assert.throws(() => runRepositoryPreflight(root, runner, {}, {}, {
    onProgress: () => { throw new Error('observer unavailable'); },
  }), /observer unavailable/u);
  assert.equal(calls, 0);
});

test('targeted timeout retains bounded failure evidence and no passing progress', () => {
  const events = [];
  const runner = (_executable, args) => args[0] === '--test'
    ? { status: null, error: Object.assign(new Error('child deadline'), { code: 'ETIMEDOUT' }),
      stderr: 'not ok 1 - retained failure\n  error: assertion evidence\n# fail 1' }
    : { status: 0, stdout: '', stderr: '' };
  assert.throws(() => runRepositoryPreflight(root, runner, {}, {}, {
    now: () => 0, onProgress: (event) => events.push(event),
  }), (error) => error.code === 'ETIMEDOUT' && /retained failure/u.test(error.message));
  assert.equal(events.at(-1).operation, 'targeted preflight tests');
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(events.at(-1).outcome, 'timeout');
});

test('a slow observer cannot spend the deadline and still admit a child', () => {
  let time = 0;
  let calls = 0;
  const events = [];
  assert.throws(() => runRepositoryPreflight(root, () => { calls += 1; }, {}, {}, {
    now: () => time,
    onProgress: (event) => { events.push(event); time = 210_000; },
  }), (error) => error.code === 'ETIMEDOUT');
  assert.equal(calls, 0);
  assert.deepEqual(events.map(({ status }) => status), ['started', 'failed']);
});

test('invalid clocks fail closed and rejected invocations do not poison later qualification', () => {
  for (const value of [NaN, Infinity]) {
    assert.throws(() => runRepositoryPreflight(root, successfulRunner([]), {}, {}, {
      now: () => value,
    }), /clock is invalid/u);
  }
  let time = 100;
  assert.throws(() => runRepositoryPreflight(root, () => { time = 0; return { status: 0 }; }, {}, {}, {
    now: () => time,
  }), /clock is invalid/u);
  assert.equal(runRepositoryPreflight(root, successfulRunner([]), {}, {}, {
    now: () => 0,
  }).targetedTests, 234);
});
