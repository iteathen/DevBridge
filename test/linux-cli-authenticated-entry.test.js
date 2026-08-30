import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runLinuxCliAuthenticatedEntry } from '../src/setup/linux-cli-authenticated-entry.js';
import { PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL } from '../src/setup/protected-refresh-child-contract.js';
import { PROTECTED_OPERATION_DISPATCH_PROTOCOL } from '../src/setup/protected-operation-dispatcher.js';

const GENERATION = 'a'.repeat(64);

function output() {
  let text = '';
  return Object.freeze({
    write(value) { text += value; },
    read() { return text; },
  });
}

test('authenticated entry attaches one neutral dispatch to one protected operation', async () => {
  const target = output();
  let dispatchCalls = 0;
  let performCalls = 0;
  const subject = Object.freeze({ protocol: 'local-subject-v1' });
  const performed = Object.freeze({
    protocol: PROTECTED_REFRESH_CHILD_RESULT_PROTOCOL,
    ready: true,
    changed: true,
    generation: GENERATION,
    reason: null,
  });
  const result = await runLinuxCliAuthenticatedEntry({ input: 'frame', output: target }, {
    dispatch: async (value, ports) => {
      dispatchCalls += 1;
      assert.deepEqual(value, { input: 'frame' });
      const selected = await ports.perform(subject);
      return Object.freeze({
        protocol: PROTECTED_OPERATION_DISPATCH_PROTOCOL,
        completed: true,
        output: JSON.stringify(selected),
        reason: null,
      });
    },
    perform: async (value) => { performCalls += 1; assert.equal(value, subject); return performed; },
    observeOrigin: async () => { throw new Error('owned by the injected operation'); },
  });
  assert.deepEqual(result, { completed: true, ready: true });
  assert.equal(dispatchCalls, 1);
  assert.equal(performCalls, 1);
  assert.equal(target.read(), `${JSON.stringify(performed)}\n`);
});

test('authenticated entry never promotes dispatcher completion to operation readiness', async () => {
  const target = output();
  const result = await runLinuxCliAuthenticatedEntry({ input: '{}', output: target }, {
    dispatch: async () => Object.freeze({
      protocol: PROTECTED_OPERATION_DISPATCH_PROTOCOL,
      completed: false,
      output: null,
      reason: 'input-invalid',
    }),
    perform: async () => { throw new Error('must not run'); },
    observeOrigin: async () => null,
  });
  assert.deepEqual(result, { completed: false, ready: false });
  assert.equal(target.read(), `${JSON.stringify({
    protocol: PROTECTED_OPERATION_DISPATCH_PROTOCOL,
    completed: false,
    output: null,
    reason: 'input-invalid',
  })}\n`);

  const forged = output();
  const forgedResult = await runLinuxCliAuthenticatedEntry({ input: '{}', output: forged }, {
    dispatch: async (value, ports) => {
      await ports.perform({});
      return Object.freeze({
        protocol: PROTECTED_OPERATION_DISPATCH_PROTOCOL,
        completed: true,
        output: '{"ready":true}',
        reason: null,
      });
    },
    perform: async () => Object.freeze({ protocol: 'foreign-result-v1', ready: true }),
    observeOrigin: async () => null,
  });
  assert.deepEqual(forgedResult, { completed: true, ready: false });
});

test('authenticated entry exposes only local composition ports', async () => {
  await assert.rejects(runLinuxCliAuthenticatedEntry({ input: '{}', output: output(), setup: true }, {}), /unknown field/u);
  await assert.rejects(runLinuxCliAuthenticatedEntry({ input: '{}', output: output() }, {
    dispatch: async () => null,
    perform: async () => null,
    observeOrigin: async () => null,
    fallback: async () => null,
  }), /unknown field/u);
});

test('authenticated entry is the sole explicit topology edge', async () => {
  const source = await readFile(new URL('../src/setup/linux-cli-authenticated-entry.js', import.meta.url), 'utf8');
  for (const identity of [
    './linux-cli-authentication-origin.js',
    './linux-lifecycle-authority-refresh-child.js',
    './protected-operation-dispatcher.js',
    './protected-refresh-child-contract.js',
  ]) assert.equal(source.includes(identity), true, identity);
  for (const identity of ['../app/', './setup.js', './command-options.js', 'provider', 'repository', 'virtual-machine']) {
    assert.equal(source.toLowerCase().includes(identity), false, identity);
  }
});
