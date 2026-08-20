import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibvirtEnvironmentBootstrap } from '../src/runtime/providers/libvirt-environment-bootstrap.js';

const target = 'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const location = {
  reference: 'machine-local',
  identity: '12345678-1234-4234-8234-123456789abc',
  proof: 'owned:machine',
  family: 'linux',
  network: { reference: 'network-local', proof: 'owned:network' },
};
function success(stdout) { return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr: '' }; }

test('libvirt preparation attaches only the owned network and fixed agent channel while stopped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-libvirt-bootstrap-'));
  let hasNetwork = false;
  let hasAgent = false;
  let state = 'shut off (shutdown)';
  const calls = [];
  const invoke = async (request) => {
    assert.equal(request.executable, 'virsh');
    assert.deepEqual(request.arguments.slice(0, 2), ['-c', 'qemu:///system']);
    const args = request.arguments.slice(2);
    calls.push(args);
    if (args[0] === 'domuuid') return success(`${location.identity}\n`);
    if (args[0] === 'domstate') return success(`${state}\n`);
    if (args[0] === 'net-dumpxml') return success(`<network><metadata>${location.network.proof}</metadata></network>`);
    if (args[0] === 'dumpxml') {
      return success(`<domain><metadata>${location.proof}</metadata><devices>${hasNetwork ? `<interface type="network"><source network="${location.network.reference}"/></interface>` : ''}${hasAgent ? '<channel type="unix"><target type="virtio" name="org.qemu.guest_agent.0"/></channel>' : ''}</devices></domain>`);
    }
    if (args[0] === 'attach-interface') { hasNetwork = true; return success(''); }
    if (args[0] === 'attach-device') {
      const xml = await readFile(args[2], 'utf8');
      assert.match(xml, /org\.qemu\.guest_agent\.0/u);
      hasAgent = true;
      return success('');
    }
    if (args[0] === 'qemu-agent-command') return success('{"return":{}}');
    throw new Error(`unexpected virsh call ${args.join(' ')}`);
  };
  try {
    const adapter = new LibvirtEnvironmentBootstrap({
      directory: root,
      invoke,
      locate: async () => location,
      connection: async () => ({ family: 'linux' }),
    });
    const prepared = await adapter.prepare(target);
    assert.deepEqual(prepared, { ready: true, cycleRequired: false });
    assert.equal(hasNetwork, true);
    assert.equal(hasAgent, true);
    state = 'running';
    assert.deepEqual(await adapter.activate(target), { ready: true });
    assert.deepEqual(await adapter.connection(target), { family: 'linux' });
    assert.ok(calls.some((entry) => entry[0] === 'attach-interface'));
    assert.ok(calls.some((entry) => entry[0] === 'attach-device'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('libvirt preparation requests a lifecycle cycle instead of hot-mutating missing persistent devices', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-libvirt-cycle-'));
  let mutations = 0;
  const invoke = async (request) => {
    const args = request.arguments.slice(2);
    if (args[0] === 'domuuid') return success(`${location.identity}\n`);
    if (args[0] === 'domstate') return success('running\n');
    if (args[0] === 'net-dumpxml') return success(`<network>${location.network.proof}</network>`);
    if (args[0] === 'dumpxml') return success(`<domain>${location.proof}<devices/></domain>`);
    if (args[0] === 'attach-interface' || args[0] === 'attach-device') { mutations += 1; return success(''); }
    throw new Error('unexpected');
  };
  try {
    const adapter = new LibvirtEnvironmentBootstrap({ directory: root, invoke, locate: async () => location, connection: async () => ({ family: 'linux' }) });
    assert.deepEqual(await adapter.prepare(target), { ready: false, cycleRequired: true });
    assert.equal(mutations, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
