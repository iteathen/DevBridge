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

test('preflight arguments expose only the closed targeted-test serialization option', () => {
  assert.deepEqual(parseRepositoryPreflightArguments([]), { serializeTargetedTests: false });
  assert.deepEqual(parseRepositoryPreflightArguments(['--serialize-targeted-tests']), { serializeTargetedTests: true });
  assert.throws(() => parseRepositoryPreflightArguments('--serialize-targeted-tests'), /must be an array/u);
  assert.throws(() => parseRepositoryPreflightArguments(['--serialize-targeted-tests=1']), /accepts only/u);
  assert.throws(() => parseRepositoryPreflightArguments(['--serialize-targeted-tests', '--serialize-targeted-tests']), /accepts only/u);
  assert.throws(() => parseRepositoryPreflightArguments(['--test-concurrency=8']), /accepts only/u);
});

test('serialized scheduling changes only the complete targeted-test runner invocation', () => {
  const ordinaryCalls = [];
  const ordinary = runRepositoryPreflight(root, successfulRunner(ordinaryCalls), {}, {});
  const ordinaryTestCalls = ordinaryCalls.filter(({ args }) => args[0] === '--test');
  assert.equal(ordinaryTestCalls.length, 1);
  assert.equal(ordinaryTestCalls[0].args[1], 'test/standalone-artifact.test.js');
  assert.doesNotMatch(ordinaryTestCalls[0].args.join(' '), /test-concurrency/u);

  const serializedCalls = [];
  const serialized = runRepositoryPreflight(root, successfulRunner(serializedCalls), {}, { serializeTargetedTests: true });
  const serializedTestCalls = serializedCalls.filter(({ args }) => args[0] === '--test');
  assert.equal(serializedTestCalls.length, 1);
  assert.deepEqual(serializedTestCalls[0].args.slice(0, 3), [
    '--test',
    '--test-concurrency=1',
    'test/standalone-artifact.test.js',
  ]);
  assert.equal(serialized.targetedTests, ordinary.targetedTests);
  assert.equal(serializedTestCalls[0].args.length, ordinaryTestCalls[0].args.length + 1);
});

test('programmatic preflight scheduling rejects open or malformed options before work', () => {
  assert.throws(
    () => runRepositoryPreflight(root, successfulRunner([]), {}, { testFileConcurrency: 8 }),
    /unsupported field/u,
  );
  assert.throws(
    () => runRepositoryPreflight(root, successfulRunner([]), {}, { serializeTargetedTests: 'yes' }),
    /must be boolean/u,
  );
  assert.throws(
    () => runRepositoryPreflight(root, successfulRunner([]), {}, null),
    /must be an object/u,
  );
});
