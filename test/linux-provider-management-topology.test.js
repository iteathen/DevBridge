import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL,
  observeLinuxProviderManagementTopology,
} from '../src/setup/linux-provider-management-topology.js';

const DIRECT = '/run/libvirt/virtqemud-sock';
const COMPATIBILITY = '/run/libvirt/libvirt-sock';
const UNITS = Object.freeze([
  'virtqemud.socket',
  'virtqemud.service',
  'libvirtd.socket',
  'libvirtd.service',
  'virtproxyd.socket',
  'virtproxyd.service',
]);

function unitState({ exists = false, active = false, current = true, listener = '' } = {}) {
  return Object.freeze({ exists, active, current, listener });
}

function modular(overrides = {}) {
  return Object.freeze({
    'virtqemud.socket': unitState({ exists: true, active: true, listener: `${DIRECT} (Stream)` }),
    'virtqemud.service': unitState({ exists: true }),
    'libvirtd.socket': unitState(),
    'libvirtd.service': unitState(),
    'virtproxyd.socket': unitState(),
    'virtproxyd.service': unitState(),
    ...overrides,
  });
}

function combined(overrides = {}) {
  return modular({
    'virtqemud.socket': unitState(),
    'virtqemud.service': unitState(),
    'libvirtd.socket': unitState({ exists: true, active: true, listener: `${COMPATIBILITY} (Stream)` }),
    'libvirtd.service': unitState({ exists: true }),
    ...overrides,
  });
}

function unitOutput(unit, state) {
  const socket = unit.endsWith('.socket');
  return [
    `LoadState=${state.exists ? 'loaded' : 'not-found'}`,
    `ActiveState=${state.active ? 'active' : 'inactive'}`,
    `NeedDaemonReload=${state.current ? 'no' : 'yes'}`,
    ...(socket ? [`Listen=${state.listener}`] : []),
    '',
  ].join('\n');
}

function success(stdout = '', overrides = {}) {
  return Object.freeze({ exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '', ...overrides });
}

function socket({ gid = 980, mode = 0o140660, uid = 0, kind = true, link = false } = {}) {
  return Object.freeze({
    uid,
    gid,
    mode,
    isSocket: () => kind,
    isSymbolicLink: () => link,
  });
}

function missing() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

function fixture({ units = modular(), surfaces = new Map([[DIRECT, socket()]]), groups = new Map([[980, 'virt_manage'], [981, 'compat_manage']]) } = {}) {
  const calls = [];
  return Object.freeze({
    calls,
    ports: Object.freeze({
      async invoke(request) {
        calls.push(request);
        if (request.executable === '/usr/bin/systemctl') {
          const unit = request.arguments[4];
          assert.ok(UNITS.includes(unit));
          return success(unitOutput(unit, units[unit]));
        }
        assert.equal(request.executable, '/usr/bin/getent');
        assert.equal(request.arguments[0], 'group');
        const gid = Number(request.arguments[1]);
        const name = groups.get(gid);
        if (name == null) return success('', { exitCode: 2 });
        return success(`${name}:x:${gid}:member\n`);
      },
      async stat(subject) {
        if (!surfaces.has(subject)) return missing();
        return surfaces.get(subject);
      },
    }),
  });
}

test('classifies one exact segmented group-only route without exposing local topology', async () => {
  const selected = fixture();
  const signal = new AbortController().signal;
  const observed = await observeLinuxProviderManagementTopology({ platform: 'linux', signal }, selected.ports);
  assert.deepEqual(observed, {
    protocol: LINUX_PROVIDER_MANAGEMENT_TOPOLOGY_PROTOCOL,
    platform: 'linux',
    applicable: true,
    observable: true,
    exact: true,
    classification: 'group-only',
    route: 'segmented',
    selectedCapability: { name: 'virt_manage', id: 980 },
    capabilities: [{ name: 'virt_manage', id: 980 }],
    subjects: [{ role: 'primary', policy: 'group-only', capability: { name: 'virt_manage', id: 980 } }],
    reason: null,
  });
  assert.equal(JSON.stringify(observed).includes('/run/'), false);
  assert.equal(selected.calls.filter((entry) => entry.executable === '/usr/bin/systemctl').length, 6);
  assert.equal(selected.calls.filter((entry) => entry.executable === '/usr/bin/getent').length, 1);
  for (const call of selected.calls) {
    assert.equal(call.input, null);
    assert.deepEqual(call.environment, { LANG: 'C', LC_ALL: 'C' });
    assert.equal(call.signal, signal);
  }
});

test('classifies one exact combined route and a segmented compatibility surface', async () => {
  const legacy = fixture({ units: combined(), surfaces: new Map([[COMPATIBILITY, socket()]]) });
  const legacyObserved = await observeLinuxProviderManagementTopology({ platform: 'linux' }, legacy.ports);
  assert.equal(legacyObserved.route, 'combined');
  assert.equal(legacyObserved.classification, 'group-only');

  const units = modular({
    'virtproxyd.socket': unitState({ exists: true, active: true, listener: `${COMPATIBILITY} (Stream)` }),
    'virtproxyd.service': unitState({ exists: true }),
  });
  const proxied = fixture({
    units,
    surfaces: new Map([[DIRECT, socket({ gid: 980 })], [COMPATIBILITY, socket({ gid: 981 })]]),
  });
  const observed = await observeLinuxProviderManagementTopology({ platform: 'linux' }, proxied.ports);
  assert.equal(observed.route, 'segmented');
  assert.equal(observed.classification, 'group-only');
  assert.deepEqual(observed.capabilities, [{ name: 'virt_manage', id: 980 }, { name: 'compat_manage', id: 981 }]);
  assert.deepEqual(observed.subjects.map((entry) => entry.role), ['primary', 'compatibility']);
});

test('conflicting, orphaned, and absent routes remain explicit and path-free', async () => {
  const cases = [
    [modular({
      'libvirtd.socket': unitState({ exists: true, active: true, listener: `${COMPATIBILITY} (Stream)` }),
      'libvirtd.service': unitState({ exists: true }),
    }), 'ambiguous', 'conflicting-active-routes'],
    [modular({
      'virtqemud.socket': unitState(),
      'virtqemud.service': unitState(),
      'virtproxyd.socket': unitState({ exists: true, active: true, listener: `${COMPATIBILITY} (Stream)` }),
    }), 'invalid', 'orphaned-compatibility-route'],
    [modular({ 'virtqemud.socket': unitState(), 'virtqemud.service': unitState() }), 'unavailable', 'no-active-route'],
  ];
  for (const [units, classification, reason] of cases) {
    const observed = await observeLinuxProviderManagementTopology({ platform: 'linux' }, fixture({ units, surfaces: new Map() }).ports);
    assert.equal(observed.exact, false);
    assert.equal(observed.classification, classification);
    assert.equal(observed.reason, reason);
    assert.equal(JSON.stringify(observed).includes('/run/'), false);
  }
});

test('stale definitions and unexpected listener sets fail before filesystem inspection', async () => {
  for (const units of [
    modular({ 'virtqemud.socket': unitState({ exists: true, active: true, current: false, listener: `${DIRECT} (Stream)` }) }),
    modular({ 'virtqemud.socket': unitState({ exists: true, active: true, listener: '/run/foreign (Stream)' }) }),
    modular({ 'virtqemud.socket': unitState({ exists: true, active: true, listener: `${DIRECT} (Stream) /run/extra (Stream)` }) }),
    modular({ 'virtqemud.socket': unitState({ exists: true, active: true, listener: `${DIRECT} (Datagram)` }) }),
  ]) {
    let stats = 0;
    const base = fixture({ units });
    const observed = await observeLinuxProviderManagementTopology({ platform: 'linux' }, {
      ...base.ports,
      async stat() { stats += 1; return socket(); },
    });
    assert.equal(observed.exact, false);
    assert.ok(['active-definition-stale', 'unexpected-listener'].includes(observed.reason));
    assert.equal(stats, 0);
  }
});

test('service-only traditional activation is observed but not mistaken for exact socket policy', async () => {
  const units = modular({
    'virtqemud.socket': unitState({ exists: true }),
    'virtqemud.service': unitState({ exists: true, active: true }),
  });
  const observed = await observeLinuxProviderManagementTopology({ platform: 'linux' }, fixture({ units }).ports);
  assert.equal(observed.observable, true);
  assert.equal(observed.exact, false);
  assert.equal(observed.classification, 'invalid');
  assert.equal(observed.reason, 'unsupported-activation');
});

test('missing, unexplained, linked, non-socket, and foreign-owned surfaces fail closed', async () => {
  const cases = [
    [new Map(), 'missing-active-surface'],
    [new Map([[DIRECT, socket()], [COMPATIBILITY, socket()]]), 'unexplained-surface'],
    [new Map([[DIRECT, socket({ link: true })]]), 'invalid-surface'],
    [new Map([[DIRECT, socket({ kind: false })]]), 'invalid-surface'],
    [new Map([[DIRECT, socket({ uid: 1000 })]]), 'invalid-surface'],
  ];
  for (const [surfaces, reason] of cases) {
    const observed = await observeLinuxProviderManagementTopology({ platform: 'linux' }, fixture({ surfaces }).ports);
    assert.equal(observed.exact, false);
    assert.equal(observed.reason, reason);
  }
});

test('group-only, root-only, policy-backed, and mixed access remain distinct', async () => {
  const rootOnly = await observeLinuxProviderManagementTopology({ platform: 'linux' }, fixture({
    surfaces: new Map([[DIRECT, socket({ gid: 0, mode: 0o140600 })]]),
  }).ports);
  assert.equal(rootOnly.exact, true);
  assert.equal(rootOnly.classification, 'root-only');
  assert.equal(rootOnly.selectedCapability, null);

  const policy = await observeLinuxProviderManagementTopology({ platform: 'linux' }, fixture({
    surfaces: new Map([[DIRECT, socket({ gid: 0, mode: 0o140777 })]]),
  }).ports);
  assert.equal(policy.exact, true);
  assert.equal(policy.classification, 'policy-backed');
  assert.equal(policy.selectedCapability, null);

  const units = modular({ 'virtproxyd.socket': unitState({ exists: true, active: true, listener: `${COMPATIBILITY} (Stream)` }) });
  const mixed = await observeLinuxProviderManagementTopology({ platform: 'linux' }, fixture({
    units,
    surfaces: new Map([[DIRECT, socket()], [COMPATIBILITY, socket({ gid: 0, mode: 0o140777 })]]),
  }).ports);
  assert.equal(mixed.exact, true);
  assert.equal(mixed.classification, 'mixed');
  assert.equal(mixed.selectedCapability, null);
  assert.deepEqual(mixed.capabilities, [{ name: 'virt_manage', id: 980 }]);
});

test('unknown capability identity and unavailable observations return bounded evidence', async () => {
  const unknown = await observeLinuxProviderManagementTopology({ platform: 'linux' }, fixture({ groups: new Map() }).ports);
  assert.equal(unknown.exact, false);
  assert.equal(unknown.reason, 'identity-unavailable');

  for (const failure of [
    success('', { exitCode: 1, stderr: '/secret/path' }),
    success('', { timedOut: true }),
    success('', { outputTruncated: true }),
    success('LoadState=loaded\n'),
  ]) {
    const observed = await observeLinuxProviderManagementTopology({ platform: 'linux' }, {
      invoke: async () => failure,
      stat: async () => { throw new Error('not reached'); },
    });
    assert.equal(observed.reason, 'observation-unavailable');
    assert.equal(JSON.stringify(observed).includes('secret'), false);
  }
});

test('non-Linux and widened contracts invoke no local authority', async () => {
  let invoked = false;
  const observed = await observeLinuxProviderManagementTopology({ platform: 'win32' }, {
    invoke: async () => { invoked = true; },
    stat: async () => { invoked = true; },
  });
  assert.equal(observed.applicable, false);
  assert.equal(invoked, false);
  await assert.rejects(
    () => observeLinuxProviderManagementTopology({ platform: 'linux', subject: '/tmp/x' }),
    /unknown field/u,
  );
  await assert.rejects(
    () => observeLinuxProviderManagementTopology({ platform: 'linux' }, { execute: async () => {} }),
    /unknown field/u,
  );
});

test('provider-local observer exposes no mutation, setup, lifecycle, repository, or VM authority', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-provider-management-topology.js', import.meta.url)), 'utf8');
  for (const forbidden of ['groupadd', 'useradd', 'usermod', 'sudo', 'pkexec', 'lifecycle', 'repository', 'virtualMachine', 'qcow2']) {
    assert.equal(source.includes(forbidden), false, `topology observer gained foreign authority through ${forbidden}`);
  }
  assert.equal(/['"](?:start|stop|enable|disable|daemon-reload)['"]/u.test(source), false, 'topology observer gained a mutating system-manager action');
});
