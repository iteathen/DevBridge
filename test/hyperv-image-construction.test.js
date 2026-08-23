import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HyperVImageConstruction } from '../src/runtime/providers/hyperv-image-construction.js';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-hyperv-image-build-')); }

function fakeHost() {
  const state = {
    exists: false,
    owned: false,
    machineState: 'absent',
    diskPresent: false,
    diskAttached: false,
    mediaCount: 0,
    providerIdentity: '11111111-2222-3333-4444-555555555555',
    calls: [],
    failAfterBootEffect: false,
    failAfterRetainEffect: false,
  };
  return {
    state,
    async invoke(request) {
      const script = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
      const payload = JSON.parse(request.input);
      state.calls.push({ script, payload });
      let body;
      if (script.includes('construction media attachment count is incompatible')) {
        state.exists = true;
        state.owned = true;
        state.machineState = 'off';
        state.diskPresent = true;
        state.diskAttached = true;
        state.mediaCount = 2;
        body = { ready: true, providerIdentity: state.providerIdentity };
      } else if (script.includes("diskPresent = (Test-Path")) {
        body = {
          exists: state.exists,
          owned: state.owned,
          state: state.machineState,
          diskPresent: state.diskPresent,
          diskAttached: state.exists && state.diskAttached,
          mediaCount: state.exists ? state.mediaCount : 0,
          providerIdentity: state.providerIdentity,
        };
      } else if (script.includes('construction machine is not startable')) {
        state.machineState = 'running';
        body = { started: true, state: 'running' };
      } else if (script.includes('installer must finish and power off before installed boot')) {
        if (state.machineState !== 'off') return { exitCode: 1, stdout: '', stderr: 'installer must finish and power off before installed boot', timedOut: false, aborted: false, outputTruncated: false };
        state.mediaCount = 0;
        state.machineState = 'running';
        if (state.failAfterBootEffect) {
          state.failAfterBootEffect = false;
          return { exitCode: 1, stdout: '', stderr: 'simulated transport loss after installed boot', timedOut: false, aborted: false, outputTruncated: false };
        }
        body = { started: true };
      } else if (script.includes('if ($data.force -eq $true)')) {
        state.machineState = 'off';
        body = { stopped: true, absent: false };
      } else if (script.includes('construction disk is not a standalone image')) {
        if (state.exists) {
          state.exists = false;
          state.owned = false;
          state.machineState = 'absent';
          state.diskAttached = false;
          state.mediaCount = 0;
        }
        if (state.failAfterRetainEffect) {
          state.failAfterRetainEffect = false;
          return { exitCode: 1, stdout: '', stderr: 'simulated transport loss after VM removal', timedOut: false, aborted: false, outputTruncated: false };
        }
        body = { retained: true, virtualBytes: 34359738368, allocatedBytes: 4294967296, diskIdentity: 'disk-subject' };
      } else if (script.includes('discarded = $true')) {
        state.exists = false;
        state.owned = false;
        state.machineState = 'absent';
        state.diskPresent = false;
        state.diskAttached = false;
        state.mediaCount = 0;
        body = { discarded: true };
      } else {
        throw new Error('unexpected construction script');
      }
      return { exitCode: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false, aborted: false, outputTruncated: false };
    },
  };
}

async function fixture() {
  const directory = await root();
  const sourceRoot = path.join(directory, 'source');
  const outputRoot = path.join(directory, 'output');
  const stateRoot = path.join(directory, 'state');
  await Promise.all([mkdir(sourceRoot), mkdir(outputRoot), mkdir(stateRoot)]);
  const installerBytes = 'installer-media';
  const seedBytes = 'seed-media';
  const installer = path.join(sourceRoot, 'installer.iso');
  const seed = path.join(sourceRoot, 'cidata.iso');
  await writeFile(installer, installerBytes);
  await writeFile(seed, seedBytes);
  return {
    directory, sourceRoot, outputRoot, stateRoot,
    request: {
      identity: 'subject-0123456789abcdef0123456789abcdef',
      installer: { location: installer, bytes: Buffer.byteLength(installerBytes), sha256: sha256(installerBytes) },
      seed: { location: seed, bytes: Buffer.byteLength(seedBytes), sha256: sha256(seedBytes) },
      memoryBytes: 2 * 1024 * 1024 * 1024,
      processorCount: 2,
      diskBytes: 32 * 1024 * 1024 * 1024,
      network: { reference: 'db-network-0123456789abcdef', proof: 'devbridge-owned:test-network:v1' },
    },
  };
}

function constructor(data, host, identity = 'a'.repeat(32)) {
  return new HyperVImageConstruction({ directory: data.stateRoot, sourceRoot: data.sourceRoot, outputRoot: data.outputRoot, identity, invoke: host.invoke });
}

test('Hyper-V image construction resumes exact intent through install, qualification, and retained disk', async () => {
  const data = await fixture();
  const host = fakeHost();
  try {
    const first = constructor(data, host);
    const prepared = await first.prepare(data.request);
    assert.equal(prepared.phase, 'prepared');
    assert.equal(prepared.exists, true);
    assert.equal(prepared.state, 'off');
    assert.equal(prepared.mediaCount, 2);
    assert.equal(prepared.diskAttached, true);
    await assert.rejects(() => first.locate(data.request.identity), /not available for qualification/u);

    const resumed = constructor(data, host);
    const installing = await resumed.startInstall(data.request.identity);
    assert.equal(installing.phase, 'installing');
    assert.equal(installing.state, 'running');

    host.state.machineState = 'off';
    const qualifying = await resumed.bootInstalled(data.request.identity);
    assert.equal(qualifying.phase, 'qualifying');
    assert.equal(qualifying.state, 'running');
    assert.equal(qualifying.mediaCount, 0);
    const location = await resumed.locate(data.request.identity);
    assert.match(location.reference, /^db-image-build-[a-f0-9]{16}$/u);
    assert.equal(location.proof, `devbridge-owned:${'a'.repeat(32)}:image-build:${data.request.identity}:v1`);

    await resumed.stop(data.request.identity);
    await resumed.markQualified(data.request.identity, { protocol: 'test/qualification-v1', passed: true });
    const retained = await resumed.retain(data.request.identity);
    assert.equal(retained.phase, 'retained');
    assert.equal(retained.disk.virtualBytes, 32 * 1024 * 1024 * 1024);
    assert.match(path.basename(retained.location), /^[a-f0-9]{64}\.vhdx$/u);
    assert.equal(host.state.exists, false);
    assert.equal(host.state.diskPresent, true);

    const preparePayload = host.state.calls.find((entry) => entry.script.includes('construction media attachment count is incompatible')).payload;
    assert.equal(location.reference, preparePayload.name);
    assert.equal(location.proof, preparePayload.marker);
    assert.equal(preparePayload.diskPath, retained.location);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('installed boot reconciles a provider effect whose durable phase update was lost', async () => {
  const data = await fixture();
  const host = fakeHost();
  try {
    const construction = constructor(data, host, 'b'.repeat(32));
    await construction.prepare(data.request);
    await construction.startInstall(data.request.identity);
    host.state.machineState = 'off';
    host.state.failAfterBootEffect = true;
    await assert.rejects(() => construction.bootInstalled(data.request.identity), /transport loss/u);
    const ambiguous = await construction.status(data.request.identity);
    assert.equal(ambiguous.phase, 'installing');
    assert.equal(ambiguous.state, 'running');
    assert.equal(ambiguous.mediaCount, 0);
    const bootCalls = host.state.calls.filter((entry) => entry.script.includes('installer must finish and power off before installed boot')).length;

    const resumed = constructor(data, host, 'b'.repeat(32));
    const qualifying = await resumed.bootInstalled(data.request.identity);
    assert.equal(qualifying.phase, 'qualifying');
    assert.equal(qualifying.state, 'running');
    assert.equal(host.state.calls.filter((entry) => entry.script.includes('installer must finish and power off before installed boot')).length, bootCalls);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('retention reconciles an already-removed disposable VM without deleting the qualified disk', async () => {
  const data = await fixture();
  const host = fakeHost();
  try {
    const construction = constructor(data, host, 'c'.repeat(32));
    await construction.prepare(data.request);
    await construction.startInstall(data.request.identity);
    host.state.machineState = 'off';
    await construction.bootInstalled(data.request.identity);
    await construction.stop(data.request.identity);
    await construction.markQualified(data.request.identity, { protocol: 'test/qualification-v1', passed: true });
    host.state.failAfterRetainEffect = true;
    await assert.rejects(() => construction.retain(data.request.identity), /transport loss/u);
    const ambiguous = await construction.status(data.request.identity);
    assert.equal(ambiguous.phase, 'qualified');
    assert.equal(ambiguous.exists, false);
    assert.equal(ambiguous.diskPresent, true);

    const resumed = constructor(data, host, 'c'.repeat(32));
    const retained = await resumed.retain(data.request.identity);
    assert.equal(retained.phase, 'retained');
    assert.equal(host.state.diskPresent, true);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('Hyper-V image construction refuses request drift and media mutation before effects', async () => {
  const data = await fixture();
  const host = fakeHost();
  try {
    const construction = constructor(data, host, 'd'.repeat(32));
    await construction.prepare(data.request);
    const callsAfterPrepare = host.state.calls.length;
    await assert.rejects(() => construction.prepare({ ...data.request, processorCount: 3 }), /request changed/u);
    assert.equal(host.state.calls.length, callsAfterPrepare);

    await writeFile(data.request.installer.location, 'changed-media');
    await assert.rejects(() => construction.startInstall(data.request.identity), /byte count changed|digest changed/u);
    assert.equal(host.state.machineState, 'off');
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('Hyper-V image construction rejects source escape and caller-selected provider targets', async () => {
  const data = await fixture();
  const host = fakeHost();
  try {
    const foreign = path.join(data.directory, 'foreign.iso');
    await writeFile(foreign, 'foreign');
    const construction = constructor(data, host, 'e'.repeat(32));
    await assert.rejects(() => construction.prepare({
      ...data.request,
      installer: { location: foreign, bytes: 7, sha256: sha256('foreign') },
    }), /outside the owned source root/u);
    await assert.rejects(() => construction.prepare({ ...data.request, vmName: 'foreign-vm' }), /vmName is not allowed/u);
    assert.equal(host.state.calls.length, 0);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('Hyper-V image construction fails closed when observed provider ownership changes', async () => {
  const data = await fixture();
  const host = fakeHost();
  try {
    const construction = constructor(data, host, 'f'.repeat(32));
    await construction.prepare(data.request);
    host.state.owned = false;
    await assert.rejects(() => construction.status(data.request.identity), /not owned/u);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});
