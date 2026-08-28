import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ByteChannel } from '../src/app/repository-execution/byte-channel.js';
import { OperationMaterializer } from '../src/app/repository-execution/operation-materializer.js';
import { RouteAccess } from '../src/app/repository-execution/route-access.js';
import { acquireSessionGuard } from '../src/app/repository-execution/session-guard.js';
import { WorkspaceSession } from '../src/app/repository-execution/workspace-session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('session guard admits one exact owner and refuses conflict or substituted release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-session-guard-'));
  try {
    const options = {
      directory: root,
      identity: 'opaque-target',
      conflictMessage: 'conflict',
      ownershipMessage: 'changed',
    };
    const release = await acquireSessionGuard(options);
    await assert.rejects(() => acquireSessionGuard(options), /conflict/u);
    const [file] = await readdir(root);
    await writeFile(path.join(root, file), 'substituted\n');
    await assert.rejects(() => release(), /changed/u);
    assert.equal((await readdir(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function byteFixture({ readFrames = [Buffer.from('returned')] } = {}) {
  const writes = [];
  const channel = new ByteChannel({
    target: 'opaque-target',
    limit: 16,
    put: async (target, source, destination, options) => {
      await Promise.resolve();
      const chunks = [];
      let offset = 0;
      while (true) {
        const frame = await source.read({ offset, limit: 2 });
        const data = Buffer.from(frame.data);
        chunks.push(data);
        offset += data.length;
        if (frame.eof) break;
      }
      writes.push({ target, destination, options, bytes: Buffer.concat(chunks) });
    },
    get: async (_target, _source, sink, options) => {
      let offset = 0;
      for (let index = 0; index < readFrames.length; index += 1) {
        const data = Buffer.from(readFrames[index]);
        await sink.write({ offset, data, eof: index === readFrames.length - 1 });
        offset += data.length;
      }
      return options;
    },
  });
  return { channel, writes };
}

test('byte channel copies retained input and enforces contiguous bounded output', async () => {
  const fixture = byteFixture({ readFrames: [Buffer.from('re'), Buffer.from('turn')] });
  const original = Buffer.from('source');
  const writing = fixture.channel.write(original, { class: 'input', path: 'value' });
  original.fill(0);
  await writing;
  assert.equal(fixture.writes[0].bytes.toString('utf8'), 'source');

  const emitted = [];
  await fixture.channel.emit({ class: 'output', path: 'value' }, { write: async (value) => emitted.push(Buffer.from(value)) });
  assert.equal(Buffer.concat(emitted).toString('utf8'), 'return');
  const complete = byteFixture();
  assert.equal((await complete.channel.read({ class: 'output', path: 'value' }, 16)).toString('utf8'), 'returned');

  const invalid = new ByteChannel({
    target: 'opaque-target', limit: 16, put: async () => {},
    get: async (_target, _source, sink) => sink.write({ offset: 1, data: Buffer.from('x'), eof: true }),
  });
  await assert.rejects(() => invalid.emit({ class: 'output', path: 'value' }, { write: async () => {} }), /not contiguous/u);
});

test('operation materializer stages bounded resources and one closed descriptor', async () => {
  const staged = [];
  const owner = new OperationMaterializer({
    write: async (bytes, location) => staged.push({ bytes: Buffer.from(bytes), location }),
    protectedValues: ['protected-sentinel'],
    protectedMessage: 'protected',
    scratchRoot: 'runs/one',
  });
  const result = await owner.stage({
    invocation: {
      arguments: [
        { kind: 'literal', value: '--flag' },
        { kind: 'input', name: 'context' },
        { kind: 'scratch', name: 'build' },
      ],
    },
    resolved: {
      program: 'node',
      arguments: ['--no-warnings'],
      entry: 'main.mjs',
      resources: [
        { path: 'main.mjs', bytes: Buffer.from('export default true;\n') },
        { path: 'lib/value.mjs', bytes: Buffer.from('export const value = 1;\n') },
      ],
    },
    environment: { CI: '1' },
    stdin: null,
    transfers: [{ direction: 'input', name: 'context' }],
  });
  assert.equal(staged.length, 3);
  assert.match(staged[0].location.path, /^tools\/[a-f0-9]{32}\/main\.mjs$/u);
  assert.match(result.location.path, /^control\/operation-[a-f0-9]{32}\.json$/u);
  const descriptor = JSON.parse(staged.at(-1).bytes.toString('utf8'));
  assert.equal(descriptor.protocol, 'devbridge/work-operation-v1');
  assert.equal(descriptor.program, 'node');
  assert.equal(result.arguments.at(-1).path, 'runs/one/build');

  await assert.rejects(() => owner.stage({
    invocation: { arguments: [] },
    resolved: { program: 'node', arguments: [], entry: '../escape', resources: [{ path: '../escape', bytes: Buffer.alloc(0) }] },
    environment: {}, stdin: null, transfers: [],
  }), /resource path/u);
  await assert.rejects(() => owner.stage({
    invocation: { arguments: [] }, resolved: { program: 'node', arguments: [] },
    environment: { VALUE: 'contains-protected-sentinel-value' }, stdin: null, transfers: [],
  }), /protected/u);
});

function routeOwner(overrides = {}) {
  const entry = {
    record: { subject: '123', profile: 'profile-a', identity: 'opaque-target' },
    observation: { exists: true, owned: true, compatible: true },
  };
  return new RouteAccess({
    policy: { routes: [{ subject: '123', profile: 'profile-a' }] },
    identify: async () => '123',
    select: (policy, subject) => policy.routes.find((item) => item.subject === subject),
    list: async () => [entry],
    root: async () => 'source-root',
    canonicalize: async () => 'canonical-root',
    inspect: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    messages: {
      subjectName: 'subject', absent: 'absent', ambiguous: 'ambiguous', unavailable: 'unavailable', invalidRoot: 'invalid-root',
    },
    ...overrides,
  });
}

test('route owner resolves exactly one compatible target and one admitted root', async () => {
  assert.deepEqual(await routeOwner().resolve({ value: 'scope' }), {
    subject: '123',
    route: { subject: '123', profile: 'profile-a' },
    target: 'opaque-target',
    root: 'canonical-root',
  });
  await assert.rejects(() => routeOwner({ list: async () => [] }).resolve({}), /absent/u);
  await assert.rejects(() => routeOwner({
    inspect: async () => ({ isDirectory: () => false, isSymbolicLink: () => false }),
  }).resolve({}), /invalid-root/u);
});

function sessionMessages() {
  return {
    activityUnavailable: 'activity-unavailable',
    sourceApplyMismatch: 'source-apply-mismatch',
    sourceChangedDuringSync: 'source-changed-sync',
    notPrepared: 'not-prepared',
    evidenceChanged: 'evidence-changed',
    sourceChangedDuringWork: 'source-changed-work',
    staleCandidate: 'stale-candidate',
    sourceChangedBeforeApply: 'source-changed-apply',
    cleanupUnverified: 'cleanup-unverified',
  };
}

test('workspace session sequences only its local ports and closes exact ownership', async () => {
  const calls = [];
  const snapshot = {
    manifest: { digest: 'source-digest', entries: [] },
    manifestBytes: () => Buffer.from('{}'),
    readPart: async () => { throw new Error('no parts'); },
  };
  const session = new WorkspaceSession({
    activity: {
      prepare: async () => { calls.push('prepare'); return { generation: 'generation' }; },
      health: async () => { calls.push('health'); return { ready: true, version: 'version' }; },
    },
    source: {
      snapshot: async () => { calls.push('snapshot'); return snapshot; },
      install: async () => calls.push('install'),
      observe: async () => { calls.push('observe'); return { appliedDigest: 'source-digest' }; },
      writePart: async () => calls.push('part'),
      writeManifest: async () => calls.push('manifest'),
      apply: async () => { calls.push('apply-source'); return { digest: 'source-digest' }; },
    },
    input: async () => calls.push('input'),
    operation: {
      stage: async () => { calls.push('stage-operation'); return { location: 'descriptor', arguments: [] }; },
      execute: async () => { calls.push('execute'); return { completion: 'observed', result: { exitCode: 0 } }; },
    },
    output: async () => calls.push('output'),
    candidate: {
      accepts: () => false,
      collect: async () => calls.push('collect'),
      readManifest: async () => { throw new Error('not eligible'); },
      createStage: async () => 'stage',
      stage: async () => 'staged',
      apply: async () => calls.push('apply-candidate'),
      discard: async () => calls.push('discard'),
    },
    resource: {
      assert: () => calls.push('assert-resource'),
      remove: async () => { calls.push('remove-resource'); return { state: 'verified-absent', removed: true }; },
    },
    identify: (value) => value.resource ? 'cleanup-evidence' : 'run-evidence',
    close: async () => calls.push('close'),
    messages: sessionMessages(),
  });

  assert.deepEqual(await session.prepare(), { identity: 'run-evidence' });
  await session.input('input', { read: async () => Buffer.alloc(0) });
  await session.run({ invocation: { workingDirectory: '.' }, environment: {}, transfers: [], limits: {}, stdin: null });
  await session.output('output', { write: async () => {} });
  await session.collect({ identity: 'run-evidence', operation: 'read-only' });
  assert.deepEqual(await session.cleanup({ resource: 'scratch' }), {
    state: 'verified-absent', removed: true, identity: 'cleanup-evidence',
  });
  await session.close();
  assert.deepEqual(calls, [
    'prepare', 'health', 'snapshot', 'install', 'observe', 'snapshot',
    'input', 'stage-operation', 'execute', 'output', 'snapshot',
    'assert-resource', 'prepare', 'health', 'remove-resource', 'close',
  ]);
});

test('nested execution owners import no sibling and cannot name provider or host fallback topology', async () => {
  const directory = path.join(ROOT, 'src', 'app', 'repository-execution');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(names, [
    'byte-channel.js',
    'operation-materializer.js',
    'route-access.js',
    'session-guard.js',
    'workspace-session.js',
  ]);
  const forbidden = /(?:from ['"]\.\.?\/|hyper-?v|libvirt|qemu|powershell|virsh|github|codex|environment-bridge|persistent-environment|workspace-agent|resource-agent|bubblewrap|appcontainer|processcontainer|child_process|\bspawn\b|\bexecFile\b)/imu;
  for (const name of names) {
    const source = await readFile(path.join(directory, name), 'utf8');
    assert.doesNotMatch(source, forbidden, `${name} must remain sibling- and topology-agnostic`);
  }
  const parent = await readFile(path.join(ROOT, 'src', 'app', 'repository-execution.js'), 'utf8');
  for (const name of names) {
    assert.match(parent, new RegExp(`\\./repository-execution/${name.replace('.', '\\.')}['"]`, 'u'));
  }
});
