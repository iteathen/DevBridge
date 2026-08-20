import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibvirtPersistentEnvironment } from '../src/runtime/providers/libvirt-persistent-environment.js';

function result(exitCode = 0, stdout = '', stderr = '') {
  return { exitCode, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout, stderr };
}

function fakeManagement() {
  const domains = new Map();
  const calls = [];
  const invoke = async (request) => {
    calls.push(request);
    if (request.executable === 'qemu-img') {
      if (request.arguments[0] === 'create') {
        const disk = request.arguments.at(-1);
        await mkdir(path.dirname(disk), { recursive: true });
        await writeFile(disk, 'qcow2-overlay');
        return result();
      }
      if (request.arguments[0] === 'info') {
        const disk = request.arguments.at(-1);
        const stateText = await readFile(path.join(path.dirname(path.dirname(disk)), '..', 'state.json'), 'utf8').catch(() => null);
        let parent = null;
        if (stateText) {
          const state = JSON.parse(stateText);
          const record = Object.values(state.records)[0];
          parent = record?.parentPath ?? null;
        }
        if (!parent) {
          const create = [...calls].reverse().find((call) => call.executable === 'qemu-img' && call.arguments[0] === 'create');
          parent = create?.arguments[create.arguments.indexOf('-b') + 1];
        }
        return result(0, JSON.stringify([
          { filename: disk, format: 'qcow2', 'virtual-size': 4096, 'backing-filename': parent, 'full-backing-filename': parent },
          { filename: parent, format: 'qcow2', 'virtual-size': 4096 },
        ]));
      }
    }
    if (request.executable !== 'virsh') return result(1, '', 'unexpected executable');
    const args = request.arguments;
    if (args.includes('list')) return result(0, `${[...domains.keys()].join('\n')}\n`);
    if (args.includes('define')) {
      const file = args.at(-1);
      const xml = await readFile(file, 'utf8');
      const name = xml.match(/<name>([^<]+)<\/name>/u)[1];
      const uuid = xml.match(/<uuid>([^<]+)<\/uuid>/u)[1];
      domains.set(name, { uuid, xml, state: 'shut off' });
      return result();
    }
    const name = args.at(-1) === '--reason' ? args.at(-2) : args.at(-1);
    if (args.includes('domuuid')) return result(0, `${domains.get(name).uuid}\n`);
    if (args.includes('domstate')) return result(0, `${domains.get(name).state}\n`);
    if (args.includes('dumpxml')) return result(0, domains.get(name).xml);
    if (args.includes('start')) { domains.get(name).state = 'running'; return result(); }
    if (args.includes('shutdown')) { domains.get(name).state = 'shut off'; return result(); }
    if (args.includes('destroy')) { domains.get(name).state = 'shut off'; return result(); }
    if (args.includes('undefine')) { domains.delete(name); return result(); }
    return result(1, '', `unexpected virsh call: ${args.join(' ')}`);
  };
  return { invoke, calls, domains };
}

test('libvirt persistent adapter creates explicit qcow2 lineage and a provider-owned domain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-lv-'));
  const sourceRoot = path.join(root, 'images');
  const sourcePath = path.join(sourceRoot, 'base.qcow2');
  const fake = fakeManagement();
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(sourcePath, 'immutable-base');
    const adapter = new LibvirtPersistentEnvironment({
      directory: path.join(root, 'persistent'), sourceRoot,
      identity: '0123456789abcdef0123456789abcdef', invoke: fake.invoke,
    });
    const identity = 'env-cccccccccccccccccccccccccccccccc';
    const source = { identity: 'img-cccccccccccccccccccccccccccccccc', revision: 'r1', digest: 'c'.repeat(64), handle: { location: sourcePath, format: 'qcow2' } };
    const settings = { memoryBytes: 2147483648, processorCount: 2, firmware: 'efi' };
    const created = await adapter.provision({ identity, source, settings });
    assert.equal(created.compatible, true);
    assert.equal(created.storage.sourceIdentity, source.identity);
    const create = fake.calls.find((call) => call.executable === 'qemu-img' && call.arguments[0] === 'create');
    assert.deepEqual(create.arguments.slice(0, 7), ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', await realpath(sourcePath)]);
    const domain = [...fake.domains.values()][0];
    assert.match(domain.xml, /<backingStore type="file"><format type="qcow2"\/><source file=/u);
    assert.match(domain.xml, /<owner xmlns="urn:devbridge:ownership">devbridge-owned:/u);
    assert.equal(domain.xml.includes('<interface'), false);

    assert.equal((await adapter.start(identity)).state, 'running');
    assert.equal((await adapter.stop(identity)).state, 'shut off');
    assert.equal(await readFile(sourcePath, 'utf8'), 'immutable-base');

    const state = JSON.parse(await readFile(path.join(root, 'persistent', 'state.json'), 'utf8'));
    const diskPath = state.records[identity].diskPath;
    await unlink(diskPath);
    await writeFile(diskPath, 'replacement-overlay');
    const tampered = await adapter.observe(identity);
    assert.equal(tampered.compatible, false);
    assert.match(tampered.reason, /writable filesystem identity changed/u);
    await assert.rejects(() => adapter.drop(identity), /writable filesystem identity changed/u);
    assert.equal(fake.calls.some((call) => call.executable === 'virsh' && call.arguments.includes('undefine')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('libvirt persistent adapter refuses unadmitted source locations before invoking management commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-lv-path-'));
  const sourceRoot = path.join(root, 'images');
  const outside = path.join(root, 'outside.qcow2');
  const fake = fakeManagement();
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(outside, 'outside');
    const adapter = new LibvirtPersistentEnvironment({
      directory: path.join(root, 'persistent'), sourceRoot,
      identity: '0123456789abcdef0123456789abcdef', invoke: fake.invoke,
    });
    await assert.rejects(() => adapter.provision({
      identity: 'env-dddddddddddddddddddddddddddddddd',
      source: { identity: 'img-dddddddddddddddddddddddddddddddd', revision: 'r1', digest: 'd'.repeat(64), handle: { location: outside, format: 'qcow2' } },
      settings: { memoryBytes: 2147483648, processorCount: 2, firmware: 'efi' },
    }), /outside the admitted root/u);
    assert.equal(fake.calls.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('libvirt persistent adapter validates its own settings stud before producing domain XML', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage3-lv-contract-'));
  const sourceRoot = path.join(root, 'images');
  const sourcePath = path.join(sourceRoot, 'base.qcow2');
  const fake = fakeManagement();
  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(sourcePath, 'immutable-base');
    const adapter = new LibvirtPersistentEnvironment({
      directory: path.join(root, 'persistent'), sourceRoot,
      identity: '0123456789abcdef0123456789abcdef', invoke: fake.invoke,
    });
    await assert.rejects(() => adapter.provision({
      identity: 'env-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      source: { identity: 'img-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', revision: 'r1', digest: 'e'.repeat(64), handle: { location: sourcePath, format: 'qcow2' } },
      settings: { memoryBytes: 2147483648, processorCount: '</vcpu><device/>', firmware: 'efi' },
    }), /processorCount is invalid/u);
    assert.equal(fake.calls.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
