import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createLinuxLifecycleAuthorityPlan,
} from '../src/setup/linux-lifecycle-authority.js';
import {
  bindLinuxLifecycleAuthorityIdentity,
  LINUX_LIFECYCLE_AUTHORITY_IDENTITY_BINDING_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority-identity-binding.js';
import {
  initialLinuxLifecycleAuthorityOwnershipRecord,
  normalizeLinuxLifecycleAuthorityOwnershipRecord,
} from '../src/setup/linux-lifecycle-authority-records.js';

const IDENTITY = Object.freeze({ serviceUid: 1201, readGid: 1202, coordinationGid: 1203, managementGid: 1204 });

function fixture({ identity = null, reconciledIdentity = IDENTITY, reconcileChanged = true, failSave = false } = {}) {
  const plan = createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/state/devbridge',
    operatorName: 'operator',
    managementGroup: 'virt-control',
  });
  let record = normalizeLinuxLifecycleAuthorityOwnershipRecord({
    ...initialLinuxLifecycleAuthorityOwnershipRecord(plan),
    localIdentity: identity,
  }, plan);
  let saveFailures = 0;
  const calls = [];
  const ports = {
    state: {
      async load() { calls.push(['load']); return record; },
      async save(value) {
        calls.push(['save', value.localIdentity]);
        if (failSave && saveFailures++ === 0) throw new Error('identity checkpoint interrupted');
        record = normalizeLinuxLifecycleAuthorityOwnershipRecord(value, plan);
        return record;
      },
    },
    async reconcile(request) {
      calls.push(['reconcile', request]);
      return Object.freeze({ applicable: true, changed: reconcileChanged, identity: reconciledIdentity });
    },
  };
  return { calls, get record() { return record; }, plan, ports, value: Object.freeze({ plan }) };
}

test('fresh identity binding projects a closed local contract and saves numeric evidence last', async () => {
  const values = fixture();
  const result = await bindLinuxLifecycleAuthorityIdentity(values.value, values.ports);
  assert.deepEqual(result, { protocol: LINUX_LIFECYCLE_AUTHORITY_IDENTITY_BINDING_PROTOCOL, changed: true, identity: IDENTITY });
  assert.deepEqual(values.calls.map(([name]) => name), ['load', 'reconcile', 'save']);
  assert.deepEqual(values.calls[1][1], {
    serviceAccount: values.plan.service.user,
    operatorAccount: values.plan.service.operator,
    readGroup: values.plan.service.readGroup,
    coordinationGroup: values.plan.service.coordinationGroup,
    managementGroup: values.plan.service.managementGroup,
    home: values.plan.service.account.home,
    shell: values.plan.service.account.shell,
    claimEstablished: true,
    expectedIdentity: null,
  });
  assert.deepEqual(values.record.localIdentity, IDENTITY);
});

test('an existing numeric binding is an immutable expected identity and does not rewrite state', async () => {
  const values = fixture({ identity: IDENTITY, reconcileChanged: false });
  const result = await bindLinuxLifecycleAuthorityIdentity(values.value, values.ports);
  assert.equal(result.changed, false);
  assert.deepEqual(values.calls[1][1].expectedIdentity, IDENTITY);
  assert.equal(values.calls.some(([name]) => name === 'save'), false);

  const repaired = fixture({ identity: IDENTITY, reconcileChanged: true });
  const repairedResult = await bindLinuxLifecycleAuthorityIdentity(repaired.value, repaired.ports);
  assert.equal(repairedResult.changed, true);
  assert.equal(repaired.calls.some(([name]) => name === 'save'), false);
});

test('interrupted binding persistence resumes the same reconciliation and writes only missing evidence', async () => {
  const values = fixture({ failSave: true });
  await assert.rejects(() => bindLinuxLifecycleAuthorityIdentity(values.value, values.ports), /checkpoint interrupted/u);
  assert.equal(values.record.localIdentity, null);
  const resumed = await bindLinuxLifecycleAuthorityIdentity(values.value, values.ports);
  assert.deepEqual(resumed.identity, IDENTITY);
  assert.equal(values.calls.filter(([name]) => name === 'reconcile').length, 2);
  assert.equal(values.calls.filter(([name]) => name === 'save').length, 2);
});

test('missing claims and numeric drift block without persisting a new binding', async () => {
  const missing = fixture();
  const missingPorts = { ...missing.ports, state: { ...missing.ports.state, async load() { missing.calls.push(['load']); return null; } } };
  await assert.rejects(() => bindLinuxLifecycleAuthorityIdentity(missing.value, missingPorts), /established ownership claim/u);
  assert.deepEqual(missing.calls.map(([name]) => name), ['load']);

  const changed = fixture({ identity: IDENTITY, reconciledIdentity: { ...IDENTITY, serviceUid: 1301 } });
  await assert.rejects(() => bindLinuxLifecycleAuthorityIdentity(changed.value, changed.ports), /changed its immutable binding/u);
  assert.equal(changed.calls.some(([name]) => name === 'save'), false);
});

test('invalid reconciliation and inexact save evidence fail closed', async () => {
  for (const identity of [
    { ...IDENTITY, serviceUid: 0 },
    { ...IDENTITY, coordinationGid: IDENTITY.readGid },
  ]) {
    const values = fixture({ reconciledIdentity: identity });
    await assert.rejects(() => bindLinuxLifecycleAuthorityIdentity(values.value, values.ports), /invalid|alias/u);
    assert.equal(values.calls.some(([name]) => name === 'save'), false);
  }

  const unavailable = fixture();
  unavailable.ports.reconcile = async () => ({ applicable: false, changed: false, identity: IDENTITY });
  await assert.rejects(() => bindLinuxLifecycleAuthorityIdentity(unavailable.value, unavailable.ports), /not applicable/u);

  const inexact = fixture();
  inexact.ports.state.save = async (value) => normalizeLinuxLifecycleAuthorityOwnershipRecord({ ...value, localIdentity: null }, inexact.plan);
  await assert.rejects(() => bindLinuxLifecycleAuthorityIdentity(inexact.value, inexact.ports), /record is not exact/u);
});

test('identity binding rejects topology-shaped interfaces and remains isolated from neighboring owners', async () => {
  const values = fixture();
  await assert.rejects(() => bindLinuxLifecycleAuthorityIdentity({ ...values.value, provider: 'foreign' }, values.ports), /unknown field/u);
  await assert.rejects(() => bindLinuxLifecycleAuthorityIdentity(values.value, { ...values.ports, command: () => {} }), /unknown field/u);
  assert.equal(values.calls.length, 0);
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-lifecycle-authority-identity-binding.js', import.meta.url)), 'utf8');
  for (const forbidden of ['systemctl', 'useradd', 'groupadd', 'usermod', 'libvirt', 'qemu', 'polkit', 'repository', 'virtual machine', 'powershell', 'hyper-v', 'sudo']) {
    assert.equal(source.toLowerCase().includes(forbidden), false, `identity binding gained neighboring authority through ${forbidden}`);
  }
});
