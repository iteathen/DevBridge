import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibvirtEnvironment } from '../src/runtime/providers/libvirt-environment.js';

function result(exitCode = 0, stdout = '', stderr = '') {
  return { exitCode, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr };
}

function fakeManagement() {
  const networks = new Map();
  const pools = new Map();
  const calls = [];
  const invoke = async (request) => {
    calls.push(request);
    const args = request.arguments;
    const action = args.find((value) => ['net-list','net-info','net-uuid','net-dumpxml','net-define','net-autostart','net-start','net-destroy','net-undefine','pool-list','pool-info','pool-uuid','pool-dumpxml','pool-define','pool-autostart','pool-start','pool-refresh','pool-destroy','pool-undefine'].includes(value));
    const target = args[args.length - 1];
    if (request.executable === 'qemu-img') {
      return result(0, JSON.stringify([{ format: 'qcow2', 'virtual-size': 4096 }]));
    }
    if (action === 'net-list') return result(0, `${[...networks.keys()].join('\n')}\n`);
    if (action === 'net-define') {
      const xml = await readFile(target, 'utf8');
      const name = xml.match(/<name>([^<]+)<\/name>/u)[1];
      const uuid = xml.match(/<uuid>([^<]+)<\/uuid>/u)[1];
      networks.set(name, { uuid, xml, active: false });
      return result();
    }
    if (action === 'net-info') {
      const item = networks.get(target);
      return item ? result(0, `Name: ${target}\nActive: ${item.active ? 'yes' : 'no'}\n`) : result(1, '', 'not found');
    }
    if (action === 'net-uuid') return result(0, `${networks.get(target).uuid}\n`);
    if (action === 'net-dumpxml') return result(0, networks.get(target).xml);
    if (action === 'net-start') { networks.get(target).active = true; return result(); }
    if (action === 'net-autostart') return result();
    if (action === 'net-destroy') { networks.get(target).active = false; return result(); }
    if (action === 'net-undefine') { networks.delete(target); return result(); }
    if (action === 'pool-list') return result(0, `${[...pools.keys()].join('\n')}\n`);
    if (action === 'pool-define') {
      const xml = await readFile(target, 'utf8');
      const name = xml.match(/<name>([^<]+)<\/name>/u)[1];
      const uuid = xml.match(/<uuid>([^<]+)<\/uuid>/u)[1];
      pools.set(name, { uuid, xml, active: false });
      return result();
    }
    if (action === 'pool-info') {
      const item = pools.get(target);
      return item ? result(0, `Name: ${target}\nActive: ${item.active ? 'yes' : 'no'}\n`) : result(1, '', 'not found');
    }
    if (action === 'pool-uuid') return result(0, `${pools.get(target).uuid}\n`);
    if (action === 'pool-dumpxml') return result(0, pools.get(target).xml);
    if (action === 'pool-start') { pools.get(target).active = true; return result(); }
    if (action === 'pool-autostart' || action === 'pool-refresh') return result();
    if (action === 'pool-destroy') { pools.get(target).active = false; return result(); }
    if (action === 'pool-undefine') { pools.delete(target); return result(); }
    return result(1, '', `unexpected command: ${request.executable} ${args.join(' ')}`);
  };
  return { invoke, calls, networks, pools };
}

test('adapter validates qcow2 base media within its managed asset root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-lv-image-'));
  const assetRoot = path.join(root, 'images');
  const inside = path.join(assetRoot, 'fixture.qcow2');
  const outside = path.join(root, 'outside.qcow2');
  const fake = fakeManagement();
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(assetRoot, { recursive: true }));
    await writeFile(inside, 'inside');
    await writeFile(outside, 'outside');
    const adapter = new LibvirtEnvironment({
      directory: path.join(root, 'control'), assetRoot,
      identity: '0123456789abcdef0123456789abcdef', invoke: fake.invoke,
    });
    assert.equal((await adapter.inspectImage({ location: inside })).format, 'qcow2');
    await assert.rejects(() => adapter.inspectImage({ location: outside }), /outside the managed asset root/u);
    await assert.rejects(() => adapter.observeInstance('owner/project'), /opaque local token/u);
    assert.equal(fake.calls[0].executable, 'qemu-img');
    assert.deepEqual(fake.calls[0].arguments.slice(0, 3), ['info', '--output=json', '--backing-chain']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('network and storage lifecycle uses generated local identities and exact provider ownership records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-lv-owned-'));
  const fake = fakeManagement();
  try {
    const adapter = new LibvirtEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef', invoke: fake.invoke,
    });
    await adapter.ensureStorage();
    await adapter.ensureNetwork();
    assert.equal(fake.pools.size, 1);
    assert.equal(fake.networks.size, 1);
    const [networkName, network] = [...fake.networks.entries()][0];
    assert.match(networkName, /^db-network-[a-f0-9]{16}$/u);
    assert.match(network.uuid, /^[a-f0-9-]{36}$/u);
    assert.equal(network.xml.includes('owner/project'), false);
    await adapter.releaseNetwork();
    await adapter.releaseStorage();
    assert.equal(fake.networks.size, 0);
    assert.equal(fake.pools.size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted network activation reconciles the already-defined owned object instead of defining another', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-lv-reconcile-'));
  const fake = fakeManagement();
  let failStart = true;
  const invoke = async (request) => {
    if (request.arguments.includes('net-start') && failStart) {
      failStart = false;
      return result(1, '', 'simulated activation interruption');
    }
    return fake.invoke(request);
  };
  try {
    const adapter = new LibvirtEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef', invoke,
    });
    await assert.rejects(() => adapter.ensureNetwork(), /simulated activation interruption/u);
    assert.equal(fake.networks.size, 1);
    const original = [...fake.networks.values()][0].uuid;
    await adapter.reconcile();
    assert.equal(fake.networks.size, 1);
    assert.equal([...fake.networks.values()][0].uuid, original);
    assert.equal([...fake.networks.values()][0].active, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
