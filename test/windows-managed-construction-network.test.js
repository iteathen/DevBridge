import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOWS_MANAGED_CONSTRUCTION_NETWORK_ID,
  WindowsManagedConstructionNetwork,
} from '../src/runtime/providers/windows-managed-construction-network.js';

function success(value) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' };
}

test('Windows-managed construction network is selected by exact system identity without mutation', async () => {
  const calls = [];
  const network = new WindowsManagedConstructionNetwork({
    async invoke(request) { calls.push(request); return success({ ready: true, reason: null }); },
  });
  const observed = await network.inspect();
  assert.equal(observed.ready, true);
  assert.deepEqual(observed.description, {
    protocol: 'devbridge/windows-managed-construction-network-v1',
    binding: {
      control: 'system',
      reference: WINDOWS_MANAGED_CONSTRUCTION_NETWORK_ID,
      proof: WINDOWS_MANAGED_CONSTRUCTION_NETWORK_ID,
    },
    addressing: { method: 'automatic' },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].input), { reference: WINDOWS_MANAGED_CONSTRUCTION_NETWORK_ID });
  const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Get-VMSwitch -Id/u);
  assert.match(script, /SwitchType/u);
  assert.doesNotMatch(script, /\b(?:New|Set|Remove)-(?:VMSwitch|NetNat|NetIPAddress)\b/u);
});

test('Windows-managed construction network fails closed on absent or incompatible system state', async () => {
  const absent = new WindowsManagedConstructionNetwork({ invoke: async () => success({ ready: false, reason: 'Windows-managed construction network is absent' }) });
  assert.deepEqual(await absent.inspect(), { ready: false, reason: 'Windows-managed construction network is absent', description: null });
  await assert.rejects(() => absent.require(), /network is absent/u);

  const invalid = new WindowsManagedConstructionNetwork({ invoke: async () => success({ ready: false, reason: 'Windows-managed construction network type is incompatible' }) });
  assert.equal((await invalid.inspect()).ready, false);
  await assert.rejects(() => invalid.require(), /type is incompatible/u);
});

test('Windows-managed construction network converts unbounded provider failures into bounded readiness evidence', async () => {
  const network = new WindowsManagedConstructionNetwork({
    invoke: async () => ({ exitCode: 1, timedOut: false, aborted: false, outputTruncated: false, stdout: '', stderr: 'x'.repeat(10_000) }),
  });
  const observed = await network.inspect();
  assert.equal(observed.ready, false);
  assert.match(observed.reason, /^Windows-managed construction network observation failed:/u);
  assert.ok(observed.reason.length < 2_200);
});
