import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HyperVEnvironment } from '../src/runtime/providers/hyperv-environment.js';

function success(value) {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTruncated: false, stdout: JSON.stringify(value), stderr: '' };
}

test('adapter keeps command authority local and rejects external image paths and context-shaped instance names', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-'));
  const assetRoot = path.join(root, 'images');
  const outside = path.join(root, 'outside.vhdx');
  const inside = path.join(assetRoot, 'fixture.vhdx');
  const calls = [];
  try {
    await writeFile(outside, 'outside');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(assetRoot, { recursive: true }));
    await writeFile(inside, 'inside');
    const invoke = async (request) => {
      calls.push(request);
      if (calls.length === 1) return success({ ready: true });
      return success({ usable: true, format: 'vhdx', contentIdentity: 'disk-1', parentIdentity: null, virtualSize: 1024 });
    };
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot,
      identity: '0123456789abcdef0123456789abcdef', invoke,
    });
    const status = await adapter.inspect();
    assert.equal(status.capabilities.management.ready, true);
    await assert.rejects(() => adapter.inspectImage({ location: outside }), /outside the managed asset root/u);
    const observed = await adapter.inspectImage({ location: inside });
    assert.equal(observed.format, 'vhdx');
    assert.equal(calls.every((call) => call.executable === 'powershell.exe'), true);
    await assert.rejects(() => adapter.observeInstance('owner/project'), /opaque local token/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted network setup retains one local plan and reconciles the same owned identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-reconcile-'));
  const calls = [];
  let fail = true;
  try {
    const invoke = async (request) => {
      calls.push(request);
      if (fail) {
        fail = false;
        return { ...success({}), exitCode: 1, stderr: 'simulated interruption' };
      }
      return success({ ready: true });
    };
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef', invoke,
    });
    await assert.rejects(() => adapter.ensureNetwork(), /simulated interruption/u);
    await adapter.ensureNetwork();
    const first = JSON.parse(calls[0].input);
    const second = JSON.parse(calls[1].input);
    const script = Buffer.from(calls[0].arguments.at(-1), 'base64').toString('utf16le');
    assert.deepEqual(second, first);
    assert.match(first.name, /^db-network-[a-f0-9]{16}$/u);
    assert.equal(JSON.stringify(first).includes('owner/project'), false);
    assert.match(script, /^\$ProgressPreference = 'SilentlyContinue'/u);
    assert.match(script, /\[uint64\]4294967295 -shr \(32 - \$bits\)/u);
    assert.doesNotMatch(script, /0xffffffff/iu);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded provider failures retain the actionable end of noisy PowerShell errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-error-'));
  try {
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef',
      invoke: async () => ({ ...success({}), exitCode: 1, stderr: `${'progress '.repeat(400)}provider-tail` }),
    });
    const status = await adapter.inspect();
    assert.match(status.capabilities.management.reason, /provider-tail/u);
    assert.ok(status.capabilities.management.reason.length < 2_200);
  } finally { await rm(root, { recursive: true, force: true }); }
});
