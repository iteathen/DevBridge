import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompletionReconciliation } from '../src/app/ubuntu-production-image-physical-canary/completion-reconciliation.js';
import { createConfigurationContract } from '../src/app/ubuntu-production-image-physical-canary/configuration-contract.js';
import { createMutationLease } from '../src/app/ubuntu-production-image-physical-canary/mutation-lease.js';
import { createPreparationContract } from '../src/app/ubuntu-production-image-physical-canary/preparation-contract.js';
import { createProgressCoordinator } from '../src/app/ubuntu-production-image-physical-canary/progress-coordinator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = 'src/app/ubuntu-production-image-physical-canary.js';
const directory = 'src/app/ubuntu-production-image-physical-canary';
const children = Object.freeze({
  'completion-reconciliation.js': 'createCompletionReconciliation',
  'configuration-contract.js': 'createConfigurationContract',
  'mutation-lease.js': 'createMutationLease',
  'preparation-contract.js': 'createPreparationContract',
  'progress-coordinator.js': 'createProgressCoordinator',
});
const LOCAL_IMPORT = /(?:\bfrom\s*|(?:^|\n)\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gu;
const FOREIGN_TOPOLOGY = /Ubuntu|Hyper-V|HyperV|VHDX|\bVM\b|\bguest\b|\bprovider\b/u;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function layout() {
  return Object.freeze({
    root: 'root',
    lease: 'lease',
    selection: 'selection',
    progress: 'progress',
    preparation: 'preparation',
    sourceRoot: 'inputs',
    cache: 'cache',
    source: 'source',
    prepared: 'prepared',
    operation: 'operation',
    output: 'output',
    access: 'access',
    foundation: 'foundation',
  });
}

function progressMessages() {
  return Object.freeze({
    evidenceUnavailable: 'evidence unavailable',
    progressBlocked: (value) => `blocked:${value}`,
    progressing: 'progressing',
    slow: 'slow',
    progressPending: 'pending',
    progressUnavailable: 'unavailable',
    lifecyclePending: (value) => `lifecycle:${value}`,
    outputNotReady: 'output pending',
    endpointNotReady: (value) => `endpoint:${value}`,
    endpointUnready: (value) => `inspection:${value}`,
    readinessExpired: (value) => `expired:${value}`,
    shutdownPending: 'shutdown pending',
    advancementLimit: 'limit',
  });
}

test('physical canary children import independently and do not name current topology or siblings', async () => {
  const peerNames = Object.keys(children);
  for (const [name, expectedExport] of Object.entries(children)) {
    const source = readFileSync(path.join(root, directory, name), 'utf8');
    assert.deepEqual([...source.matchAll(LOCAL_IMPORT)].map((match) => match[1]), [], `${name} must not import local topology`);
    assert.equal(FOREIGN_TOPOLOGY.test(source), false, `${name} must not name current external topology`);
    for (const peer of peerNames.filter((value) => value !== name)) assert.equal(source.includes(peer), false, `${name} must not name peer ${peer}`);
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${encodeURIComponent(`${directory}/${name}`)}`;
    const module = await import(url);
    assert.equal(typeof module[expectedExport], 'function', `${name} must expose its local contract`);
  }
});

test('only the physical canary parent knows the complete nested and external topology', () => {
  const source = readFileSync(path.join(root, parent), 'utf8');
  const nestedImports = [...source.matchAll(LOCAL_IMPORT)]
    .map((match) => match[1])
    .filter((value) => value.startsWith('./ubuntu-production-image-physical-canary/'))
    .sort();
  assert.deepEqual(nestedImports, Object.keys(children).map((name) => `./ubuntu-production-image-physical-canary/${name}`).sort());
  assert.match(source, /HyperVEnvironmentBootstrap/u);
  assert.match(source, /createUbuntuProductionImageQualification/u);
  assert.match(source, /createSshAccessMaterial/u);
});

test('configuration contract owns bounded values and neutral path derivation', async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'db-config-child-'));
  try {
    const contract = createConfigurationContract({
      protocol: 'test/config-v1',
      selectionField: 'selectionValue',
      normalizeSelection: (value) => Object.freeze({ selected: value }),
      limits: { minimumMemoryBytes: 1, maximumMemoryBytes: 10, minimumDiskBytes: 2, maximumDiskBytes: 20, maximumProcessors: 4 },
      layout: layout(),
    });
    const raw = {
      protocol: 'test/config-v1',
      stateDirectory,
      keyring: path.join(stateDirectory, 'keyring'),
      selectionValue: 'choice',
      resources: { memoryBytes: 5, processorCount: 2, diskBytes: 12 },
    };
    const config = contract.normalize(raw);
    assert.deepEqual(config.selection, { selected: 'choice' });
    assert.equal(config.resources.processorCount, 2);
    const paths = contract.derivePaths(config, 'item');
    assert.equal(paths.lease, path.join(stateDirectory, 'root', 'lease'));
    assert.equal(paths.source, path.join(stateDirectory, 'root', 'inputs', 'item', 'source'));
    assert.equal(paths.foundation, path.join(stateDirectory, 'foundation'));
    assert.throws(() => contract.normalize({ ...raw, unexpected: true }), /unexpected is not allowed/u);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('preparation contract binds receipts and seed values to exact local evidence', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'db-preparation-child-'));
  try {
    const values = {
      installer: Buffer.from('installer'),
      seed: Buffer.from('seed'),
      identity: Buffer.from('identity'),
      known: Buffer.from('known'),
    };
    for (const [name, value] of Object.entries(values)) await writeFile(path.join(temporary, name), value);
    const contract = createPreparationContract({
      protocol: 'test/preparation-v1',
      seedProtocol: 'test/seed-v1',
      accessFamily: 'local',
      sha256Pattern: /^[a-f0-9]{64}$/u,
      snapshotPattern: /^snapshot$/u,
      maximumSeedBytes: 4096,
      messages: { identityFile: 'local access identity', identityChanged: 'local access identity changed' },
    });
    const expected = Object.freeze({ identity: 'item', payloadGeneration: 'payload', packageGeneration: 'packages', packageSnapshot: 'snapshot', resources: Object.freeze({ memoryBytes: 1, processorCount: 1, diskBytes: 2 }) });
    const receipt = contract.normalize({
      protocol: 'test/preparation-v1',
      identity: 'item',
      payloadGeneration: 'payload',
      packageGeneration: 'packages',
      packageSnapshot: 'snapshot',
      resources: expected.resources,
      network: { control: 'owned', reference: 'reference', proof: 'proof', addressing: 'automatic' },
      installer: { location: path.join(temporary, 'installer'), bytes: values.installer.length, sha256: digest(values.installer) },
      seed: { location: path.join(temporary, 'seed'), bytes: values.seed.length, sha256: digest(values.seed) },
      access: {
        family: 'local',
        user: 'user',
        identityFile: path.join(temporary, 'identity'),
        knownHostsFile: path.join(temporary, 'known'),
        identitySha256: digest(values.identity),
        knownHostsSha256: digest(values.known),
      },
    }, expected);
    assert.equal(await contract.verify(receipt), receipt);

    const seedLocation = path.join(temporary, 'access-seed');
    await writeFile(seedLocation, JSON.stringify({ protocol: 'test/seed-v1', target: 'item', user: 'user', authorizedKey: 'authorized', hostPrivateKey: 'private', hostPublicKey: 'public', revision: 1 }));
    assert.deepEqual(await contract.readSeed(seedLocation, 'item'), { user: 'user', authorizedKey: 'authorized', hostPrivateKey: 'private', hostPublicKey: 'public' });
    await writeFile(receipt.access.identityFile, 'changed');
    await assert.rejects(() => contract.verify(receipt), /access identity changed/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('mutation lease releases only its exact owner record', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'db-mutation-lease-child-'));
  const location = path.join(temporary, 'lease');
  try {
    const lease = createMutationLease({ protocol: 'test/lease-v1', conflictMessage: 'already active', createToken: () => 'a'.repeat(32) });
    assert.equal(await lease.run(location, async () => {
      const record = JSON.parse(await readFile(location, 'utf8'));
      assert.deepEqual(record, { protocol: 'test/lease-v1', token: 'a'.repeat(32), pid: process.pid });
      return 41;
    }), 41);
    await assert.rejects(() => readFile(location), { code: 'ENOENT' });

    await assert.rejects(() => lease.run(location, async () => { throw new Error('work failed'); }), /work failed/u);
    await assert.rejects(() => readFile(location), { code: 'ENOENT' });

    const legacyRecord = `${process.pid}\n`;
    await writeFile(location, legacyRecord);
    await assert.rejects(() => lease.run(location, async () => {}), /already active/u);
    assert.equal(await readFile(location, 'utf8'), legacyRecord);
    await rm(location);

    const acquired = path.join(temporary, 'acquired');
    await lease.run(location, async () => {
      await rename(location, acquired);
      await writeFile(location, 'replacement');
    });
    assert.equal(await readFile(location, 'utf8'), 'replacement');
    assert.match(await readFile(acquired, 'utf8'), /"token":"a{32}"/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('mutation lease rejects a concurrent owner and releases after the current work finishes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'db-mutation-lease-concurrent-'));
  const location = path.join(temporary, 'lease');
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  try {
    const lease = createMutationLease({ protocol: 'test/lease-v1', conflictMessage: 'already active', createToken: () => 'b'.repeat(32) });
    const owner = lease.run(location, async () => { entered(); await wait; return 'done'; });
    await ready;
    await assert.rejects(() => lease.run(location, async () => 'wrong'), /already active/u);
    release();
    assert.equal(await owner, 'done');
    await assert.rejects(() => readFile(location), { code: 'ENOENT' });
  } finally {
    release?.();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('completion reconciliation attempts every neutral action and aggregates bounded failures', async () => {
  const calls = [];
  const reconciliation = createCompletionReconciliation();
  const reason = await reconciliation.run([
    { failure: 'first failed', async perform() { calls.push('first'); throw new Error('one'); } },
    { failure: 'second failed', async perform() { calls.push('second'); } },
    { failure: 'third failed', async perform() { calls.push('third'); throw new Error('three'); } },
  ]);
  assert.deepEqual(calls, ['first', 'second', 'third']);
  assert.equal(reason, 'first failed: one; third failed: three');
});

test('progress coordinator owns a bounded neutral frontier without advancing waiting work', async () => {
  let advances = 0;
  const coordinator = createProgressCoordinator({ maximumAdvances: 2, measureReadiness: () => ({ classification: 'observing' }), messages: progressMessages() });
  const result = await coordinator.run({
    async inspect() { return { phase: 'running', complete: false, blocked: false }; },
    async advance() { advances += 1; return {}; },
    async observeProgress() { return { state: 'running', mediaCount: 1, liveness: { classification: 'observing' } }; },
    async observeLifecycle() { throw new Error('unused'); },
    async resolveEndpoint() { throw new Error('unused'); },
    async inspectEndpoint() { throw new Error('unused'); },
    async reconcileCompletion() { throw new Error('unused'); },
    present(current, details) { return { current, ...details }; },
  });
  assert.equal(result.state, 'waiting');
  assert.equal(result.reason, 'pending');
  assert.equal(advances, 0);
});
