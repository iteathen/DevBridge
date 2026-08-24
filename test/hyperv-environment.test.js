import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HyperVEnvironment } from '../src/runtime/providers/hyperv-environment.js';

const execFileAsync = promisify(execFile);

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
    assert.deepEqual(second, first);
    assert.match(first.name, /^db-network-[a-f0-9]{16}$/u);
    assert.equal(JSON.stringify(first).includes('owner/project'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows prefix collision arithmetic remains unsigned across every IPv4 prefix length', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-prefix-'));
  let networkScript;
  try {
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef',
      invoke: async (request) => {
        networkScript = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
        return success({ ready: true });
      },
    });
    await adapter.ensureNetwork();

    const functionStart = networkScript.indexOf('function Convert-IPv4ToUInt32');
    const functionEnd = networkScript.indexOf('$switch = Get-VMSwitch');
    assert.ok(functionStart >= 0 && functionEnd > functionStart, 'network prefix functions must remain inspectable');
    const probe = `$ErrorActionPreference = 'Stop'
${networkScript.slice(functionStart, functionEnd)}
foreach ($bits in 0..32) {
  if (-not (Prefix-Overlaps "10.0.0.0/$bits" "10.0.0.0/$bits")) { throw "equal prefix failed at /$bits" }
}
if (-not (Prefix-Overlaps '192.168.10.0/24' '192.168.10.128/25')) { throw 'nested prefixes did not overlap' }
if (Prefix-Overlaps '192.168.10.0/24' '192.168.11.0/24') { throw 'disjoint prefixes overlapped' }
@{ ready = $true } | ConvertTo-Json -Compress
`;
    const encoded = Buffer.from(probe, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    assert.deepEqual(JSON.parse(stdout), { ready: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
