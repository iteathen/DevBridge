import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createLinuxLifecycleAuthorityPlan,
} from '../src/setup/linux-lifecycle-authority.js';
import {
  reconcileLinuxLifecycleAuthorityEndpointTopology,
  LINUX_LIFECYCLE_AUTHORITY_ENDPOINT_TOPOLOGY_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority-endpoint-topology.js';
import {
  LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
} from '../src/setup/linux-lifecycle-authority-records.js';
import {
  LINUX_PROTECTED_STORAGE_PROTOCOL,
} from '../src/setup/linux-protected-storage.js';

function plan() {
  return createLinuxLifecycleAuthorityPlan({
    stateDirectory: '/home/alice/.devbridge/state',
    operatorName: 'alice',
    managementGroup: Object.freeze({ name: 'provider-control', id: 108 }),
  });
}

function claim(selected, localIdentity = Object.freeze({ serviceUid: 995, operatorUid: 1000, readGid: 994, coordinationGid: 993, managementGid: 108 })) {
  return Object.freeze({
    protocol: LINUX_LIFECYCLE_AUTHORITY_OWNERSHIP_PROTOCOL,
    authorityIdentity: selected.authorityIdentity,
    serviceName: selected.service.name,
    operatorName: selected.service.operator,
    managementGroup: selected.service.managementGroup,
    managementGid: selected.service.managementGroupId,
    localIdentity,
    activeGeneration: null,
    stagedGeneration: null,
    retainedGenerations: Object.freeze([]),
  });
}

function fixture({
  content = null,
  directoriesReady = false,
  definitionPolicy = true,
  directoryPolicy = true,
  throwAfterSave = false,
  stateClaim,
} = {}) {
  const selected = plan();
  const state = {
    claim: stateClaim === undefined ? claim(selected) : stateClaim,
    content,
    readyPaths: new Set(directoriesReady ? [
      selected.endpoints.parentDirectory,
      selected.endpoints.runRoot,
      selected.coordination.directory,
      selected.coordination.lock.path,
      selected.endpoints.read.directory,
      selected.endpoints.mutation.directory,
      selected.configuration.root,
      selected.configuration.endpoint.directory,
      selected.configuration.handoff.directory,
      selected.activity.root,
      selected.activity.endpoint.directory,
      selected.activity.handoff.directory,
    ] : []),
  };
  const calls = [];
  let interrupted = false;
  let widenObservation = false;

  function observation(contract, exists, policy = true, extra = {}) {
    return Object.freeze({
      protocol: LINUX_PROTECTED_STORAGE_PROTOCOL,
      path: contract.path,
      exists,
      kind: exists && policy,
      owner: exists && policy,
      group: exists && policy,
      mode: exists && policy,
      observedMode: exists ? contract.mode ?? 0o755 : null,
      ...extra,
    });
  }

  const ports = {
    state: Object.freeze({
      async load() { calls.push(['state-load']); return state.claim; },
    }),
    async inspect({ contract, kind }) {
      calls.push(['inspect', contract.path, kind]);
      let observed;
      if (contract.path === '/etc/tmpfiles.d') observed = observation(contract, true);
      else if (contract.path === selected.endpoints.definition.path) observed = observation(contract, state.content != null, definitionPolicy);
      else observed = observation(contract, state.readyPaths.has(contract.path), directoryPolicy);
      return widenObservation ? Object.freeze({ ...observed, extra: true }) : observed;
    },
    async load({ contract }) {
      calls.push(['load', contract.path]);
      const bytes = Buffer.from(state.content, 'utf8');
      return Object.freeze({ protocol: LINUX_PROTECTED_STORAGE_PROTOCOL, content: bytes, size: bytes.length });
    },
    async save({ contract, parent, content: bytes, maximumBytes }) {
      calls.push(['save', contract.path, parent.path, maximumBytes]);
      state.content = bytes.toString('utf8');
      if (throwAfterSave && !interrupted) {
        interrupted = true;
        throw new Error('publication interrupted');
      }
      return observation(contract, true, true, { changed: true });
    },
    async apply(request) {
      calls.push(['apply', request]);
      for (const target of [
        selected.endpoints.parentDirectory,
        selected.endpoints.runRoot,
        selected.coordination.directory,
        selected.coordination.lock.path,
        selected.endpoints.read.directory,
        selected.endpoints.mutation.directory,
        selected.configuration.root,
        selected.configuration.endpoint.directory,
        selected.configuration.handoff.directory,
        selected.activity.root,
        selected.activity.endpoint.directory,
        selected.activity.handoff.directory,
      ]) state.readyPaths.add(target);
      return true;
    },
  };
  return {
    plan: selected,
    state,
    calls,
    ports,
    widen() { widenObservation = true; },
  };
}

function reconcile(values, overrides = {}) {
  return reconcileLinuxLifecycleAuthorityEndpointTopology({
    plan: values.plan,
    platform: 'linux',
    ...overrides,
  }, values.ports);
}

function effects(values) {
  return values.calls.filter(([name]) => ['save', 'apply'].includes(name));
}

test('fresh endpoint topology publishes exact bytes and applies exact local definition', async () => {
  const values = fixture();
  const result = await reconcile(values);
  assert.deepEqual(result, {
    protocol: LINUX_LIFECYCLE_AUTHORITY_ENDPOINT_TOPOLOGY_PROTOCOL,
    platform: 'linux',
    applicable: true,
    ready: true,
    changed: true,
  });
  assert.equal(values.state.content, values.plan.endpoints.definition.content);
  assert.equal(values.state.readyPaths.size, 12);
  assert.deepEqual(effects(values).map(([name]) => name), ['save', 'apply']);
  const save = effects(values)[0];
  assert.deepEqual(save.slice(1), [values.plan.endpoints.definition.path, '/etc/tmpfiles.d', 64 * 1024]);
  const apply = effects(values)[1][1];
  assert.deepEqual(apply, { path: values.plan.endpoints.definition.path, platform: 'linux', signal: null });
});

test('exact endpoint topology is a mutation-free no-op', async () => {
  const values = fixture({ content: plan().endpoints.definition.content, directoriesReady: true });
  const result = await reconcile(values);
  assert.equal(result.changed, false);
  assert.deepEqual(effects(values), []);
});

test('already-published definition recreates volatile directories after reboot without rewriting bytes', async () => {
  const selected = plan();
  const values = fixture({ content: selected.endpoints.definition.content, directoriesReady: false });
  const result = await reconcile(values);
  assert.equal(result.changed, true);
  assert.deepEqual(effects(values).map(([name]) => name), ['apply']);
});

test('completed publication is recovered by observation instead of replay', async () => {
  const values = fixture({ throwAfterSave: true });
  await assert.rejects(() => reconcile(values), /publication interrupted/u);
  assert.equal(values.state.content, values.plan.endpoints.definition.content);
  const resumed = await reconcile(values);
  assert.equal(resumed.ready, true);
  assert.equal(effects(values).filter(([name]) => name === 'save').length, 1);
  assert.equal(effects(values).filter(([name]) => name === 'apply').length, 1);
});

test('foreign definition bytes and existing directory policy block before mutation', async () => {
  const foreign = fixture({ content: 'd /run/foreign 0777 root root -\n', directoriesReady: true });
  await assert.rejects(() => reconcile(foreign), /unadmitted bytes/u);
  assert.deepEqual(effects(foreign), []);

  const selected = plan();
  const wrongDirectory = fixture({ content: selected.endpoints.definition.content, directoriesReady: true, directoryPolicy: false });
  await assert.rejects(() => reconcile(wrongDirectory), /policy is invalid/u);
  assert.deepEqual(effects(wrongDirectory), []);

  const wrongDefinition = fixture({ content: selected.endpoints.definition.content, directoriesReady: true, definitionPolicy: false });
  await assert.rejects(() => reconcile(wrongDefinition), /policy is invalid/u);
  assert.deepEqual(effects(wrongDefinition), []);
});

test('ownership claim and numeric identity are required before any topology effect', async () => {
  const missing = fixture({ stateClaim: null });
  await assert.rejects(() => reconcile(missing), /established ownership claim/u);
  assert.deepEqual(effects(missing), []);

  const selected = plan();
  const unbound = fixture({ stateClaim: claim(selected, null) });
  unbound.plan = selected;
  await assert.rejects(() => reconcile(unbound), /immutable numeric identity/u);
  assert.deepEqual(effects(unbound), []);
});

test('widened lower evidence and application results fail closed', async () => {
  const widened = fixture();
  widened.widen();
  await assert.rejects(() => reconcile(widened), /unknown field/u);
  assert.deepEqual(effects(widened), []);

  const selected = plan();
  const inexactApply = fixture({ content: selected.endpoints.definition.content });
  inexactApply.ports.apply = async (request) => { inexactApply.calls.push(['apply', request]); return { ready: true }; };
  await assert.rejects(() => reconcile(inexactApply), /application is invalid/u);
});

test('non-Linux topology is explicitly unattached and invokes no ports', async () => {
  let invoked = false;
  const poison = async () => { invoked = true; throw new Error('invoked'); };
  const result = await reconcileLinuxLifecycleAuthorityEndpointTopology({ platform: 'win32' }, {
    state: { load: poison },
    inspect: poison,
    load: poison,
    save: poison,
    apply: poison,
  });
  assert.deepEqual(result, { protocol: LINUX_LIFECYCLE_AUTHORITY_ENDPOINT_TOPOLOGY_PROTOCOL, platform: 'win32', applicable: false });
  assert.equal(invoked, false);
});

test('topology composition rejects widened inputs and contains no neighboring machine mechanics', async () => {
  const values = fixture();
  await assert.rejects(() => reconcile(values, { provider: 'forbidden' }), /unknown field/u);
  await assert.rejects(() => reconcile(values, { signal: {} }), /cancellation signal is invalid/u);
  const forged = fixture();
  forged.plan = {
    ...forged.plan,
    endpoints: {
      ...forged.plan.endpoints,
      definition: { ...forged.plan.endpoints.definition, content: `${forged.plan.endpoints.definition.content}d /etc/foreign 0777 root root -\n` },
    },
  };
  await assert.rejects(() => reconcile(forged), /plan is invalid/u);
  assert.deepEqual(effects(forged), []);
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-lifecycle-authority-endpoint-topology.js', import.meta.url)), 'utf8');
  for (const forbidden of ['provider', 'repository', 'virtualMachine', 'libvirt', 'qemu', 'qcow2', 'sudo', 'pkexec', '/usr/bin/', 'systemctl']) {
    assert.equal(source.includes(forbidden), false, `endpoint topology gained neighboring authority through ${forbidden}`);
  }
});
