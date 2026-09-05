import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEnvironmentActivityRuntime } from '../src/app/environment-activity-runtime.js';
import {
  ENVIRONMENT_BRIDGE_PROTOCOL,
  EnvironmentBridge,
} from '../src/runtime/environment-bridge.js';
import {
  executionProfileSubject,
  executionWorkspaceIdentity,
  executionWorkspaceTarget,
} from '../src/app/execution-profile-routing.js';
import { ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL } from '../src/runtime/environment-activity-policy.js';

const PROFILE = 'linux-development';
const PHYSICAL = `env-${'a'.repeat(32)}`;
const SUBJECT = '42';
const LOGICAL = executionWorkspaceTarget(SUBJECT, PROFILE);
const WORKSPACE = executionWorkspaceIdentity(SUBJECT, PROFILE);

function policy(subject = SUBJECT) {
  return {
    protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
    routes: [{
      subject,
      profile: PROFILE,
      preferred: true,
      validation: true,
    }],
  };
}

function state() {
  const entry = {
    record: { identity: PHYSICAL, subject: executionProfileSubject(PROFILE), profile: PROFILE },
    observation: { identity: PHYSICAL, exists: true, owned: true, compatible: true, state: 'running', reason: null },
  };
  return {
    async inspect() { return { ready: true, identity: 'foundation-a' }; },
    async listEnvironments() { return [structuredClone(entry)]; },
    async observeEnvironment(target) { assert.equal(target, PHYSICAL); return structuredClone(entry); },
  };
}

function response(frame, body) {
  return { protocol: ENVIRONMENT_BRIDGE_PROTOCOL, request: frame.request, target: frame.target, kind: frame.kind, ok: true, body };
}

test('protected activity maps an accepted logical target and scopes every exchange location', async () => {
  const prepared = [];
  const exchanged = [];
  const runtime = createEnvironmentActivityRuntime({
    state: state(),
    loadPolicy: async () => policy(),
    preparation: { async ensure(target) { prepared.push(target); return { generation: 'bootstrap-v1', connection: { identityFile: 'must-not-cross' } }; } },
    exchange: async (frame) => {
      exchanged.push(frame);
      if (frame.kind === 'put') {
        const bytes = Buffer.from(frame.body.data, 'base64');
        return response(frame, { nextOffset: frame.body.offset + bytes.length, complete: frame.body.eof, digest: frame.body.digest });
      }
      if (frame.kind === 'get') {
        const bytes = Buffer.from('result');
        return response(frame, { offset: frame.body.offset, data: bytes.toString('base64'), eof: true, digest: createHash('sha256').update(bytes).digest('hex') });
      }
      throw new Error('unexpected');
    },
  });

  assert.deepEqual(await runtime.prepare(LOGICAL), { generation: 'bootstrap-v1' });
  assert.deepEqual(prepared, [PHYSICAL]);
  const bridge = new EnvironmentBridge({ exchange: runtime.exchange });
  const input = Buffer.from('source');
  await bridge.put(LOGICAL, { async read() { return { data: input, eof: true }; } }, { class: 'input', path: 'source/main.c' });
  let output = null;
  await bridge.get(LOGICAL, { class: 'output', path: 'result/value' }, { async write(frame) { output = frame.data; } });
  assert.deepEqual(output, Buffer.from('result'));
  assert.equal(exchanged[0].target, PHYSICAL);
  assert.deepEqual(exchanged[0].body.destination, { class: 'input', path: `workspaces/${WORKSPACE}/source/main.c` });
  assert.deepEqual(exchanged[1].body.source, { class: 'output', path: `workspaces/${WORKSPACE}/result/value` });
});

test('protected activity returns only synthetic environment observations', async () => {
  const runtime = createEnvironmentActivityRuntime({
    state: state(),
    loadPolicy: async () => policy(),
    preparation: { async ensure() { return { generation: 'bootstrap-v1' }; } },
    exchange: async () => { throw new Error('unexpected'); },
  });
  const entries = await runtime.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].record.identity, LOGICAL);
  assert.equal(entries[0].record.subject, SUBJECT);
  assert.equal(entries[0].record.profile, PROFILE);
  assert.equal(JSON.stringify(entries).includes(PHYSICAL), false);
  assert.deepEqual(await runtime.observe(LOGICAL), entries[0]);
});

test('route removal or unknown target fails before preparation or exchange', async () => {
  let selectedPolicy = policy();
  let preparationCalls = 0;
  let exchangeCalls = 0;
  const runtime = createEnvironmentActivityRuntime({
    state: state(),
    loadPolicy: async () => selectedPolicy,
    preparation: { async ensure() { preparationCalls += 1; return { generation: 'bootstrap-v1' }; } },
    exchange: async () => { exchangeCalls += 1; throw new Error('must not exchange'); },
  });
  selectedPolicy = { ...policy(), routes: [] };
  await assert.rejects(() => runtime.prepare(LOGICAL), /not admitted/u);
  const bridge = new EnvironmentBridge({ exchange: runtime.exchange });
  await assert.rejects(() => bridge.health(LOGICAL), /bridge exchange failed/u);
  assert.equal(preparationCalls, 0);
  assert.equal(exchangeCalls, 0);
});
