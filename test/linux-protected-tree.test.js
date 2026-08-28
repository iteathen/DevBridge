import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ensureLinuxProtectedDirectory,
  inspectLinuxProtectedEntry,
  transferLinuxProtectedFile,
  verifyLinuxProtectedFile,
  writeLinuxProtectedFile,
} from '../src/setup/linux-protected-storage.js';
import {
  installLinuxProtectedTree,
  LINUX_PROTECTED_TREE_PROTOCOL,
  LINUX_PROTECTED_TREE_VERIFICATION_PROTOCOL,
  verifyLinuxProtectedTree,
} from '../src/setup/linux-protected-tree.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture({ failSyncAt = null, failAfterMoveAt = null } = {}) {
  const entries = new Map();
  const calls = [];
  const put = (target, kind, {
    uid = 0,
    gid = 0,
    mode = kind === 'directory' ? 0o755 : 0o444,
    content = Buffer.alloc(0),
  } = {}) => entries.set(target, { kind, uid, gid, mode, content: Buffer.from(content) });
  put('/protected/work', 'directory', { mode: 0o700 });
  put('/protected/final', 'directory', { mode: 0o700 });
  const nodeBytes = Buffer.from('node executable bytes');
  const entryBytes = Buffer.from('service entry bytes');
  put('/source/node', 'file', { mode: 0o755, content: nodeBytes });
  put('/source/entry', 'file', { mode: 0o644, content: entryBytes });
  const get = (target) => entries.get(target) ?? null;
  const exactParent = (parent) => {
    const value = get(parent.path);
    return value?.kind === 'directory'
      && value.uid === parent.ownerId
      && value.gid === parent.groupId
      && (parent.mode == null ? (value.mode & 0o022) === 0 : value.mode === parent.mode);
  };
  const ports = {
    async observeEntry({ contract, kind }) {
      calls.push(['observe', contract.path, kind]);
      const value = get(contract.path);
      return Object.freeze({
        exists: value != null,
        kind: value?.kind === kind,
        owner: value?.uid === contract.ownerId,
        group: value?.gid === contract.groupId,
        mode: value != null && (contract.mode == null ? (value.mode & 0o022) === 0 : value.mode === contract.mode),
      });
    },
    async ensureDirectory({ contract, parent }) {
      calls.push(['ensure', contract.path]);
      if (!exactParent(parent)) throw new Error('fake parent is invalid');
      const current = get(contract.path);
      if (current && (current.kind !== 'directory' || current.uid !== contract.ownerId || current.gid !== contract.groupId)) {
        throw new Error('fake directory authority is invalid');
      }
      put(contract.path, 'directory', { uid: contract.ownerId, gid: contract.groupId, mode: contract.mode });
      return Object.freeze({ exists: true, kind: true, owner: true, group: true, mode: true, changed: current == null });
    },
    async writeContent({ contract, parent, content }) {
      calls.push(['content', contract.path]);
      if (!exactParent(parent)) throw new Error('fake parent is invalid');
      const current = get(contract.path);
      if (current && (current.kind !== 'file' || current.uid !== contract.ownerId || current.gid !== contract.groupId)) {
        throw new Error('fake content authority is invalid');
      }
      entries.delete(`${contract.path}.devbridge-pending`);
      put(contract.path, 'file', { uid: contract.ownerId, gid: contract.groupId, mode: contract.mode, content });
    },
    async transferContent({ input, output, parent }) {
      calls.push(['transfer', output.path]);
      if (!exactParent(parent)) throw new Error('fake parent is invalid');
      const source = get(input.path);
      if (source?.kind !== 'file' || source.content.length !== input.size || sha256(source.content) !== input.digest) {
        throw new Error('fake input evidence is invalid');
      }
      const current = get(output.path);
      if (current && (current.kind !== 'file' || current.uid !== output.ownerId || current.gid !== output.groupId)) {
        throw new Error('fake transfer authority is invalid');
      }
      entries.delete(`${output.path}.devbridge-pending`);
      put(output.path, 'file', { uid: output.ownerId, gid: output.groupId, mode: output.mode, content: source.content });
    },
    async verifyFile({ contract, size, digest }) {
      calls.push(['verify', contract.path]);
      const value = get(contract.path);
      if (value?.kind !== 'file' || value.uid !== contract.ownerId || value.gid !== contract.groupId
          || value.mode !== contract.mode || value.content.length !== size || sha256(value.content) !== digest) {
        throw new Error('fake file evidence is invalid');
      }
      return Object.freeze({ ready: true, size, digest });
    },
    async listDirectory(target) {
      calls.push(['list', target]);
      return [...entries.keys()]
        .filter((entry) => path.posix.dirname(entry) === target)
        .map((entry) => path.posix.basename(entry));
    },
    async move(source, destination) {
      calls.push(['rename', source, destination]);
      if (get(destination)) throw new Error('fake destination exists');
      const selected = [...entries.entries()].filter(([target]) => target === source || target.startsWith(`${source}/`));
      if (selected.length === 0) throw new Error('fake source missing');
      for (const [target] of selected) entries.delete(target);
      for (const [target, value] of selected) entries.set(`${destination}${target.slice(source.length)}`, value);
      const count = calls.filter(([name]) => name === 'rename').length;
      if (count === failAfterMoveAt) throw new Error('rename result interrupted');
    },
    async syncDirectory(target) {
      calls.push(['sync', target]);
      const count = calls.filter(([name]) => name === 'sync').length;
      if (count === failSyncAt) throw new Error('directory sync interrupted');
    },
  };
  const request = (overrides = {}) => ({
    working: {
      path: '/protected/work/tree',
      parent: { path: '/protected/work', ownerId: 0, groupId: 0, mode: 0o700 },
    },
    installed: {
      path: '/protected/final/tree',
      parent: { path: '/protected/final', ownerId: 0, groupId: 0, mode: 0o700 },
    },
    ownerId: 0,
    groupId: 0,
    creatorIds: { ownerId: 0, groupId: 0 },
    directoryMode: 0o755,
    directories: ['bin', 'package', 'package/src', 'package/src/entry'],
    entries: [
      {
        kind: 'transfer',
        relative: 'bin/node',
        mode: 0o555,
        maximumBytes: 1024,
        input: { path: '/source/node', size: nodeBytes.length, digest: sha256(nodeBytes) },
      },
      {
        kind: 'content',
        relative: 'package/package.json',
        mode: 0o444,
        maximumBytes: 1024,
        content: '{"private":true}\n',
      },
      {
        kind: 'transfer',
        relative: 'package/src/entry/service.mjs',
        mode: 0o444,
        maximumBytes: 1024,
        input: { path: '/source/entry', size: entryBytes.length, digest: sha256(entryBytes) },
      },
    ],
    ...overrides,
  });
  return { calls, entries, nodeBytes, entryBytes, ports, put, request };
}

function verificationRequest(value) {
  return {
    root: {
      path: value.installed.path,
      ownerId: value.ownerId,
      groupId: value.groupId,
      mode: value.directoryMode,
    },
    directoryMode: value.directoryMode,
    directories: value.directories,
    entries: value.entries.map((entry) => {
      const content = entry.kind === 'content' ? Buffer.from(entry.content) : null;
      return {
        relative: entry.relative,
        mode: entry.mode,
        maximumBytes: entry.maximumBytes,
        size: entry.kind === 'content' ? content.length : entry.input.size,
        digest: entry.kind === 'content' ? sha256(content) : entry.input.digest,
      };
    }),
  };
}

test('protected tree installs one exact immutable shape and then reconciles as a no-op', async () => {
  const values = fixture();
  const first = await installLinuxProtectedTree(values.request(), values.ports);
  const second = await installLinuxProtectedTree(values.request(), values.ports);
  assert.deepEqual(first, {
    protocol: LINUX_PROTECTED_TREE_PROTOCOL,
    path: '/protected/final/tree',
    entries: 7,
    changed: true,
  });
  assert.equal(second.changed, false);
  assert.equal(values.entries.has('/protected/work/tree'), false);
  assert.deepEqual(values.entries.get('/protected/final/tree/bin/node').content, values.nodeBytes);
  assert.equal(values.entries.get('/protected/final/tree/bin/node').mode, 0o555);
  assert.equal(values.entries.get('/protected/final/tree/package/package.json').mode, 0o444);
  assert.equal(values.calls.filter(([name]) => name === 'rename').length, 1);
  assert.equal(values.calls.filter(([name]) => name === 'sync').length, 4);
});

test('an incomplete admitted working tree resumes only through declared lower operations', async () => {
  const values = fixture();
  values.put('/protected/work/tree', 'directory');
  values.put('/protected/work/tree/bin', 'directory');
  values.put('/protected/work/tree/bin/node', 'file', { mode: 0o600, content: 'stale' });
  values.put('/protected/work/tree/package', 'directory');
  values.put('/protected/work/tree/package/package.json.devbridge-pending', 'file', { mode: 0o600, content: 'partial' });
  const result = await installLinuxProtectedTree(values.request(), values.ports);
  assert.equal(result.changed, true);
  assert.equal(values.calls.some(([name, target]) => name === 'transfer' && target.endsWith('/bin/node')), true);
  assert.equal(values.calls.some(([name, target]) => name === 'content' && target.endsWith('/package/package.json')), true);
  assert.equal([...values.entries.keys()].some((target) => target.endsWith('.devbridge-pending')), false);
});

test('undeclared working state blocks before any tree mutation', async () => {
  const values = fixture();
  values.put('/protected/work/tree', 'directory');
  values.put('/protected/work/tree/unexpected', 'file', { content: 'foreign' });
  await assert.rejects(() => installLinuxProtectedTree(values.request(), values.ports), /undeclared entry/u);
  assert.equal(values.calls.some(([name]) => ['ensure', 'content', 'transfer', 'rename'].includes(name)), false);
});

test('an installed collision is verified read-only and is never overwritten or cleaned', async () => {
  const values = fixture();
  await installLinuxProtectedTree(values.request(), values.ports);
  values.entries.get('/protected/final/tree/package/package.json').content = Buffer.from('changed');
  const before = values.calls.length;
  await assert.rejects(() => installLinuxProtectedTree(values.request(), values.ports), /fake file evidence is invalid/u);
  const later = values.calls.slice(before);
  assert.equal(later.some(([name]) => ['ensure', 'content', 'transfer', 'rename'].includes(name)), false);
  assert.equal(values.entries.get('/protected/final/tree/package/package.json').content.toString(), 'changed');

  values.put('/protected/work/tree', 'directory');
  await assert.rejects(() => installLinuxProtectedTree(values.request(), values.ports), /roots are ambiguous/u);
  assert.equal(values.entries.has('/protected/work/tree'), true);
});

test('separate historical verification proves exact tree shape through observation-only ports', async () => {
  const values = fixture();
  const installed = values.request();
  await installLinuxProtectedTree(installed, values.ports);
  values.calls.length = 0;
  const result = await verifyLinuxProtectedTree(verificationRequest(installed), {
    observeEntry: values.ports.observeEntry,
    verifyFile: values.ports.verifyFile,
    listDirectory: values.ports.listDirectory,
  });
  assert.deepEqual(result, {
    protocol: LINUX_PROTECTED_TREE_VERIFICATION_PROTOCOL,
    path: installed.installed.path,
    entries: installed.directories.length + installed.entries.length,
    ready: true,
  });
  assert.equal(values.calls.some(([name]) => ['ensure', 'content', 'transfer', 'rename', 'sync'].includes(name)), false);

  values.put(`${installed.installed.path}/foreign`, 'file', { content: 'foreign' });
  await assert.rejects(() => verifyLinuxProtectedTree(verificationRequest(installed), {
    observeEntry: values.ports.observeEntry,
    verifyFile: values.ports.verifyFile,
    listDirectory: values.ports.listDirectory,
  }), /outside its bound|contents are not exact/u);
  values.entries.delete(`${installed.installed.path}/foreign`);
  values.entries.delete(`${installed.installed.path}/package/package.json`);
  await assert.rejects(() => verifyLinuxProtectedTree(verificationRequest(installed), {
    observeEntry: values.ports.observeEntry,
    verifyFile: values.ports.verifyFile,
    listDirectory: values.ports.listDirectory,
  }), /contents are not exact/u);
  values.put(`${installed.installed.path}/package/package.json`, 'file', { mode: 0o444, content: 'substituted' });
  await assert.rejects(() => verifyLinuxProtectedTree(verificationRequest(installed), {
    observeEntry: values.ports.observeEntry,
    verifyFile: values.ports.verifyFile,
    listDirectory: values.ports.listDirectory,
  }), /fake file evidence is invalid/u);
});

test('historical verification rejects widened requests and mutation-shaped ports before observation', async () => {
  const values = fixture();
  const request = verificationRequest(values.request());
  const ports = {
    observeEntry: values.ports.observeEntry,
    verifyFile: values.ports.verifyFile,
    listDirectory: values.ports.listDirectory,
  };
  await assert.rejects(() => verifyLinuxProtectedTree({ ...request, working: '/foreign' }, ports), /unknown field/u);
  await assert.rejects(() => verifyLinuxProtectedTree({ ...request, directories: ['a/b'] }, ports), /parent is undeclared/u);
  await assert.rejects(() => verifyLinuxProtectedTree({ ...request, entries: [{ ...request.entries[0], relative: '../escape' }] }, ports), /normalized relative/u);
  await assert.rejects(() => verifyLinuxProtectedTree(request, { ...ports, remove: async () => {} }), /unknown field/u);
  assert.equal(values.calls.length, 0);
});

test('historical verification rejects widened lower evidence', async () => {
  const values = fixture();
  const installation = values.request();
  await installLinuxProtectedTree(installation, values.ports);
  values.calls.length = 0;
  const request = verificationRequest(installation);
  await assert.rejects(() => verifyLinuxProtectedTree(request, {
    observeEntry: async ({ contract, kind }) => ({ ...(await values.ports.observeEntry({ contract, kind })), source: 'foreign' }),
    verifyFile: values.ports.verifyFile,
    listDirectory: values.ports.listDirectory,
  }), /unknown field/u);
  await assert.rejects(() => verifyLinuxProtectedTree(request, {
    observeEntry: values.ports.observeEntry,
    verifyFile: async (entry) => ({ ...(await values.ports.verifyFile(entry)), source: 'foreign' }),
    listDirectory: values.ports.listDirectory,
  }), /unknown field|fake file evidence/u);
});

test('post-rename directory-sync interruption reconciles exact installed state on retry', async () => {
  const values = fixture({ failSyncAt: 1 });
  await assert.rejects(() => installLinuxProtectedTree(values.request(), values.ports), /directory sync interrupted/u);
  assert.equal(values.entries.has('/protected/final/tree'), true);
  assert.equal(values.entries.has('/protected/work/tree'), false);
  const retried = await installLinuxProtectedTree(values.request(), values.ports);
  assert.equal(retried.changed, false);
  assert.equal(values.calls.filter(([name]) => name === 'rename').length, 1);
  assert.equal(values.calls.filter(([name]) => name === 'sync').length, 3);
});

test('ambiguous rename completion is observed and never replayed', async () => {
  const values = fixture({ failAfterMoveAt: 1 });
  await assert.rejects(() => installLinuxProtectedTree(values.request(), values.ports), /rename result interrupted/u);
  assert.equal(values.entries.has('/protected/final/tree'), true);
  assert.equal(values.entries.has('/protected/work/tree'), false);
  const reconciled = await installLinuxProtectedTree(values.request(), values.ports);
  assert.equal(reconciled.changed, false);
  assert.equal(values.calls.filter(([name]) => name === 'rename').length, 1);
});

test('tree contracts reject topology overlap, traversal, undeclared parents, pending collisions, and unknown fields', async () => {
  const values = fixture();
  await assert.rejects(() => installLinuxProtectedTree(values.request({ directories: ['../escape'] }), values.ports), /normalized relative/u);
  await assert.rejects(() => installLinuxProtectedTree(values.request({ directories: ['a/b'] }), values.ports), /parent is undeclared/u);
  await assert.rejects(() => installLinuxProtectedTree(values.request({ directories: ['reserved.devbridge-pending'] }), values.ports), /normalized relative/u);
  await assert.rejects(() => installLinuxProtectedTree(values.request({
    installed: {
      path: '/protected/work/tree/inside',
      parent: { path: '/protected/work/tree', ownerId: 0, groupId: 0, mode: 0o755 },
    },
  }), values.ports), /topology overlaps/u);
  await assert.rejects(() => installLinuxProtectedTree({ ...values.request(), consumerName: 'coupled' }, values.ports), /unknown field/u);
  await assert.rejects(() => installLinuxProtectedTree(values.request({
    entries: [{
      kind: 'transfer', relative: 'inside', mode: 0o444, maximumBytes: 1024,
      input: { path: '/protected/work/tree/source', size: 1, digest: 'a'.repeat(64) },
    }],
  }), values.ports), /input aliases managed state/u);
  assert.equal(values.calls.length, 0);
});

test('protected tree implementation remains isolated from neighboring topology', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/linux-protected-tree.js', import.meta.url)), 'utf8');
  for (const forbidden of ['lifecycle', 'runtime', 'systemctl', 'useradd', 'groupadd', 'libvirt', 'qemu', 'polkit', 'repository', 'virtual machine']) {
    assert.equal(source.includes(forbidden), false, `protected tree gained neighboring authority through ${forbidden}`);
  }
});

test('real Linux filesystem atomically installs and reuses an exact protected tree', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devbridge-protected-tree-'));
  try {
    const workingParent = path.join(root, 'working');
    const installedParent = path.join(root, 'installed');
    const inputPath = path.join(root, 'input.bin');
    const inputBytes = Buffer.alloc(160 * 1024 + 9, 0x31);
    await mkdir(workingParent, { mode: 0o700 });
    await mkdir(installedParent, { mode: 0o700 });
    await chmod(workingParent, 0o700);
    await chmod(installedParent, 0o700);
    await writeFile(inputPath, inputBytes);
    const rootInfo = await lstat(root);
    const ports = {
      observeEntry: inspectLinuxProtectedEntry,
      ensureDirectory: ensureLinuxProtectedDirectory,
      writeContent: writeLinuxProtectedFile,
      transferContent: transferLinuxProtectedFile,
      verifyFile: verifyLinuxProtectedFile,
      listDirectory: readdir,
      move: rename,
      async syncDirectory(target) {
        const handle = await open(target, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      },
    };
    const request = {
      working: {
        path: path.join(workingParent, 'tree'),
        parent: { path: workingParent, ownerId: rootInfo.uid, groupId: rootInfo.gid, mode: 0o700 },
      },
      installed: {
        path: path.join(installedParent, 'tree'),
        parent: { path: installedParent, ownerId: rootInfo.uid, groupId: rootInfo.gid, mode: 0o700 },
      },
      ownerId: rootInfo.uid,
      groupId: rootInfo.gid,
      creatorIds: { ownerId: rootInfo.uid, groupId: rootInfo.gid },
      directoryMode: 0o755,
      directories: ['bin', 'data'],
      entries: [
        {
          kind: 'transfer', relative: 'bin/tool', mode: 0o555, maximumBytes: 1024 * 1024,
          input: { path: inputPath, size: inputBytes.length, digest: sha256(inputBytes) },
        },
        {
          kind: 'content', relative: 'data/record.json', mode: 0o444, maximumBytes: 1024,
          content: '{"ready":true}\n',
        },
      ],
    };
    const first = await installLinuxProtectedTree(request, ports);
    const second = await installLinuxProtectedTree(request, ports);
    const verified = await verifyLinuxProtectedTree(verificationRequest(request), {
      observeEntry: async (entry) => {
        const observed = await inspectLinuxProtectedEntry(entry);
        return { exists: observed.exists, kind: observed.kind, owner: observed.owner, group: observed.group, mode: observed.mode };
      },
      verifyFile: async (entry) => {
        const observed = await verifyLinuxProtectedFile(entry);
        return { ready: observed.ready, size: observed.size, digest: observed.digest };
      },
      listDirectory: readdir,
    });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(verified.ready, true);
    assert.equal(await readFile(path.join(installedParent, 'tree', 'data', 'record.json'), 'utf8'), '{"ready":true}\n');
    assert.equal((await lstat(path.join(installedParent, 'tree', 'bin', 'tool'))).mode & 0o7777, 0o555);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
