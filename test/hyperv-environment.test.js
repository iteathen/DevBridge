import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HyperVEnvironment } from '../src/runtime/providers/hyperv-environment.js';
import { invokeCommand } from '../src/runtime/command-invocation.js';

const execFileAsync = promisify(execFile);
const PREFIX_PROBE_TIMEOUT_MS = 60_000;

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
    const functionEnd = networkScript.indexOf('$translations = @(');
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
    ], { encoding: 'utf8', timeout: PREFIX_PROBE_TIMEOUT_MS, windowsHide: true });
    assert.deepEqual(JSON.parse(stdout), { ready: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows network setup waits for the exact host interface and keeps progress out of diagnostics', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-interface-'));
  let request;
  try {
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef',
      invoke: async (received) => { request = received; return success({ ready: true }); },
    });
    await adapter.ensureNetwork();
    const networkScript = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
    const mocks = String.raw`
function Import-Module { [CmdletBinding()] param([Parameter(Position=0)]$Name) }
$script:interfaceChecks = 0
function Get-VMSwitch { [CmdletBinding()] param() @() }
function Get-NetRoute { [CmdletBinding()] param([string]$AddressFamily) @() }
function Get-NetNat { [CmdletBinding()] param([string]$Name) @() }
function New-VMSwitch { [CmdletBinding()] param([string]$Name, [string]$SwitchType) Write-Progress -Activity 'Create a virtual switch' -PercentComplete 80; [pscustomobject]@{ Name = $Name; SwitchType = $SwitchType } }
function Set-VMSwitch { [CmdletBinding()] param([string]$Name, [string]$Notes) }
function Get-NetIPInterface { [CmdletBinding()] param([string]$AddressFamily, [string]$InterfaceAlias) $script:interfaceChecks += 1; if ($script:interfaceChecks -ge 3) { [pscustomobject]@{ InterfaceIndex = 54; InterfaceAlias = $InterfaceAlias } } }
function Start-Sleep { [CmdletBinding()] param([int]$Milliseconds) }
function Get-NetIPAddress { [CmdletBinding()] param([string]$AddressFamily) @() }
function New-NetIPAddress { [CmdletBinding()] param([uint32]$InterfaceIndex, [string]$InterfaceAlias, [string]$IPAddress, [byte]$PrefixLength) if ($script:interfaceChecks -lt 3 -or $InterfaceIndex -ne 54 -or -not [string]::IsNullOrEmpty($InterfaceAlias)) { throw 'gateway creation ran before the exact interface was ready' } }
function New-NetNat { [CmdletBinding()] param([string]$Name, [string]$InternalIPInterfaceAddressPrefix) [pscustomobject]@{ Name = $Name; InternalIPInterfaceAddressPrefix = $InternalIPInterfaceAddressPrefix } }
`;
    const result = await invokeCommand({
      ...request,
      arguments: [...request.arguments.slice(0, -1), Buffer.from(`${mocks}\n${networkScript}`, 'utf16le').toString('base64')],
      timeoutMs: 20_000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ready: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows network setup fails at a bounded interface frontier before gateway or NAT mutation', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-interface-timeout-'));
  let request;
  try {
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef',
      invoke: async (received) => { request = received; return success({ ready: true }); },
    });
    await adapter.ensureNetwork();
    const networkScript = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
    const mocks = String.raw`
function Import-Module { [CmdletBinding()] param([Parameter(Position=0)]$Name) }
function Get-VMSwitch { [CmdletBinding()] param() @() }
function Get-NetRoute { [CmdletBinding()] param([string]$AddressFamily) @() }
function Get-NetNat { [CmdletBinding()] param([string]$Name) @() }
function New-VMSwitch { [CmdletBinding()] param([string]$Name, [string]$SwitchType) [pscustomobject]@{ Name = $Name; SwitchType = $SwitchType } }
function Set-VMSwitch { [CmdletBinding()] param([string]$Name, [string]$Notes) }
function Get-NetIPInterface { [CmdletBinding()] param([string]$AddressFamily, [string]$InterfaceAlias) @() }
function Start-Sleep { [CmdletBinding()] param([int]$Milliseconds) }
function Get-NetIPAddress { [CmdletBinding()] param([string]$AddressFamily) throw 'gateway observation crossed the interface frontier' }
function New-NetIPAddress { [CmdletBinding()] param() throw 'gateway mutation crossed the interface frontier' }
function New-NetNat { [CmdletBinding()] param() throw 'NAT mutation crossed the interface frontier' }
`;
    const result = await invokeCommand({
      ...request,
      arguments: [...request.arguments.slice(0, -1), Buffer.from(`${mocks}\n${networkScript}`, 'utf16le').toString('base64')],
      timeoutMs: 20_000,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /owned network interface did not become ready/u);
    assert.doesNotMatch(result.stderr, /crossed the interface frontier|<Obj S="progress"/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows network setup rejects an occupied translation slot before any mutation', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-nat-occupied-'));
  let request;
  try {
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef',
      invoke: async (received) => { request = received; return success({ ready: true }); },
    });
    await adapter.ensureNetwork();
    const networkScript = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
    const mocks = String.raw`
function Import-Module { [CmdletBinding()] param([Parameter(Position=0)]$Name) }
function Get-NetNat { [CmdletBinding()] param() @([pscustomobject]@{ Name = 'occupied'; InternalIPInterfaceAddressPrefix = '10.77.0.0/24' }) }
function Get-VMSwitch { [CmdletBinding()] param() @() }
function Get-NetRoute { [CmdletBinding()] param([string]$AddressFamily) @() }
function New-VMSwitch { [CmdletBinding()] param() throw 'switch mutation crossed the translation preflight' }
function Set-VMSwitch { [CmdletBinding()] param() throw 'switch marker mutation crossed the translation preflight' }
function New-NetIPAddress { [CmdletBinding()] param() throw 'gateway mutation crossed the translation preflight' }
function New-NetNat { [CmdletBinding()] param() throw 'translation mutation crossed the translation preflight' }
`;
    const result = await invokeCommand({
      ...request,
      arguments: [...request.arguments.slice(0, -1), Buffer.from(`${mocks}\n${networkScript}`, 'utf16le').toString('base64')],
      timeoutMs: 20_000,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /another network translation already occupies the host/u);
    assert.doesNotMatch(result.stderr, /mutation crossed the translation preflight/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows network setup reuses the exact planned translation during partial-state recovery', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-nat-recovery-'));
  let request;
  try {
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef',
      invoke: async (received) => { request = received; return success({ ready: true }); },
    });
    await adapter.ensureNetwork();
    const networkScript = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
    const mocks = String.raw`
function Import-Module { [CmdletBinding()] param([Parameter(Position=0)]$Name) }
function Get-NetNat { [CmdletBinding()] param() @([pscustomobject]@{ Name = $data.name; InternalIPInterfaceAddressPrefix = $data.prefix }) }
function Get-VMSwitch { [CmdletBinding()] param() @() }
function Get-NetRoute { [CmdletBinding()] param([string]$AddressFamily) @() }
function New-VMSwitch { [CmdletBinding()] param([string]$Name, [string]$SwitchType) [pscustomobject]@{ Name = $Name; SwitchType = $SwitchType } }
function Set-VMSwitch { [CmdletBinding()] param([string]$Name, [string]$Notes) }
function Get-NetIPInterface { [CmdletBinding()] param([string]$AddressFamily, [string]$InterfaceAlias) [pscustomobject]@{ InterfaceIndex = 71; InterfaceAlias = $InterfaceAlias } }
function Get-NetIPAddress { [CmdletBinding()] param([string]$AddressFamily) @() }
function New-NetIPAddress { [CmdletBinding()] param([uint32]$InterfaceIndex, [string]$IPAddress, [byte]$PrefixLength) }
function New-NetNat { [CmdletBinding()] param() throw 'exact translation was recreated' }
`;
    const result = await invokeCommand({
      ...request,
      arguments: [...request.arguments.slice(0, -1), Buffer.from(`${mocks}\n${networkScript}`, 'utf16le').toString('base64')],
      timeoutMs: 20_000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ready: true });
    assert.doesNotMatch(result.stderr, /exact translation was recreated/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows network setup rejects ambiguous translation observation before any mutation', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-nat-ambiguous-'));
  let request;
  try {
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef',
      invoke: async (received) => { request = received; return success({ ready: true }); },
    });
    await adapter.ensureNetwork();
    const networkScript = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
    const mocks = String.raw`
function Import-Module { [CmdletBinding()] param([Parameter(Position=0)]$Name) }
function Get-NetNat { [CmdletBinding()] param() @(
  [pscustomobject]@{ Name = $data.name; InternalIPInterfaceAddressPrefix = $data.prefix },
  [pscustomobject]@{ Name = 'additional'; InternalIPInterfaceAddressPrefix = '10.88.0.0/24' }
) }
function Get-VMSwitch { [CmdletBinding()] param() @() }
function Get-NetRoute { [CmdletBinding()] param([string]$AddressFamily) @() }
function New-VMSwitch { [CmdletBinding()] param() throw 'switch mutation crossed the translation preflight' }
function Set-VMSwitch { [CmdletBinding()] param() throw 'switch marker mutation crossed the translation preflight' }
function New-NetIPAddress { [CmdletBinding()] param() throw 'gateway mutation crossed the translation preflight' }
function New-NetNat { [CmdletBinding()] param() throw 'translation mutation crossed the translation preflight' }
`;
    const result = await invokeCommand({
      ...request,
      arguments: [...request.arguments.slice(0, -1), Buffer.from(`${mocks}\n${networkScript}`, 'utf16le').toString('base64')],
      timeoutMs: 20_000,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /host network translation state is ambiguous/u);
    assert.doesNotMatch(result.stderr, /mutation crossed the translation preflight/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows network inspection does not report readiness with additional translations', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-stage2-hv-nat-inspect-'));
  const requests = [];
  try {
    const adapter = new HyperVEnvironment({
      directory: path.join(root, 'control'), assetRoot: path.join(root, 'images'),
      identity: '0123456789abcdef0123456789abcdef',
      invoke: async (received) => { requests.push(received); return success({ ready: true }); },
    });
    await adapter.ensureNetwork();
    await adapter.inspect();
    assert.equal(requests.length, 3);
    const request = requests[2];
    const networkScript = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
    const mocks = String.raw`
function Import-Module { [CmdletBinding()] param([Parameter(Position=0)]$Name) }
function Get-VMSwitch { [CmdletBinding()] param() [pscustomobject]@{ Name = $data.name; Notes = $data.marker; SwitchType = 'Internal' } }
function Get-NetNat { [CmdletBinding()] param() @(
  [pscustomobject]@{ Name = $data.name; InternalIPInterfaceAddressPrefix = $data.prefix },
  [pscustomobject]@{ Name = 'additional'; InternalIPInterfaceAddressPrefix = '10.99.0.0/24' }
) }
function Get-NetIPAddress { [CmdletBinding()] param([string]$AddressFamily) throw 'gateway observation crossed the translation readiness frontier' }
`;
    const result = await invokeCommand({
      ...request,
      arguments: [...request.arguments.slice(0, -1), Buffer.from(`${mocks}\n${networkScript}`, 'utf16le').toString('base64')],
      timeoutMs: 20_000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ready: false, reason: 'network translation state does not match' });
    assert.doesNotMatch(result.stderr, /gateway observation crossed the translation readiness frontier/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
