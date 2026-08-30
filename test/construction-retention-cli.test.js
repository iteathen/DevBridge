import assert from 'node:assert/strict';
import test from 'node:test';
import { runConstructionRetentionCli } from '../src/app/construction-retention-cli.js';

function output() {
  const writes = [];
  return { writes, write(value) { writes.push(value); return true; } };
}

test('construction retention CLI separates bounded status from one terminal JSON result', async () => {
  const resultOutput = output();
  const statusOutput = output();
  const progress = [];
  const calls = [];
  const result = await runConstructionRetentionCli(['inspect'], {
    resultOutput,
    statusOutput,
    observe: async (operation, { output: selected }) => {
      assert.equal(selected, statusOutput);
      selected.write('bounded-status\n');
      return operation((event) => progress.push(event));
    },
    execute: async (argv, { onProgress }) => {
      calls.push(argv);
      onProgress({ phase: 'planning', completed: 0, total: null, attempt: 0 });
      return { protocol: 'terminal-result', accepted: true };
    },
  });

  assert.deepEqual(result, { protocol: 'terminal-result', accepted: true });
  assert.deepEqual(calls, [['inspect']]);
  assert.deepEqual(progress, [{ phase: 'planning', completed: 0, total: null, attempt: 0 }]);
  assert.deepEqual(statusOutput.writes, ['bounded-status\n']);
  assert.equal(resultOutput.writes.length, 1);
  assert.deepEqual(JSON.parse(resultOutput.writes[0]), result);
  assert.doesNotMatch(resultOutput.writes[0], /bounded-status/u);
});

test('construction retention CLI emits no result when the exact operation fails', async () => {
  const resultOutput = output();
  const statusOutput = output();
  const failure = new Error('exact failure');
  await assert.rejects(
    () => runConstructionRetentionCli([], {
      resultOutput,
      statusOutput,
      observe: (operation) => operation(() => {}),
      execute: async () => { throw failure; },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(resultOutput.writes, []);
});
