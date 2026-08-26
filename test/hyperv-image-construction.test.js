import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCommand } from '../src/runtime/command-invocation.js';
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
    uptimeMilliseconds: 0,
    cpuUsagePercent: 0,
    providerStatus: 'Operating normally',
    diskAllocatedBytes: 4 * 1024 * 1024,
    providerIdentity: '11111111-2222-3333-4444-555555555555',
    calls: [],
    failPrepare: false,
    failAfterBootEffect: false,
    failAfterRetainEffect: false,
    guestAddresses: [],
  };
  return {
    state,
    async invoke(request) {
      const script = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
      const payload = JSON.parse(request.input);
      state.calls.push({ script, payload });
      let body;
      if (script.includes('construction media attachment count is incompatible')) {
        if (state.failPrepare) {
          state.failPrepare = false;
          return { exitCode: 1, stdout: '', stderr: 'simulated interruption before partial reconciliation', timedOut: false, aborted: false, outputTruncated: false };
        }
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
          uptimeMilliseconds: state.uptimeMilliseconds,
          cpuUsagePercent: state.cpuUsagePercent,
          providerStatus: state.providerStatus,
          diskAllocatedBytes: state.diskAllocatedBytes,
        };
      } else if (script.includes('construction machine is not startable')) {
        state.machineState = 'running';
        body = { started: true, state: 'running' };
      } else if (script.includes('addresses = @($adapters[0].IPAddresses)')) {
        body = { ready: true, reason: null, addresses: [...state.guestAddresses] };
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
      network: { control: 'owned', reference: 'db-network-0123456789abcdef', proof: 'devbridge-owned:test-network:v1' },
    },
  };
}

function constructor(data, host, identity = 'a'.repeat(32), options = {}) {
  return new HyperVImageConstruction({ directory: data.stateRoot, sourceRoot: data.sourceRoot, outputRoot: data.outputRoot, identity, invoke: host.invoke, ...options });
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

test('Hyper-V image construction checkpoints bounded install progress, stall, and deadline evidence without VM repair', async () => {
  const data = await fixture();
  const host = fakeHost();
  let timestamp = Date.parse('2026-08-26T18:00:00.000Z');
  const now = () => new Date(timestamp);
  try {
    const construction = constructor(data, host, '4'.repeat(32), { now });
    await construction.prepare(data.request);
    const initial = await construction.startInstall(data.request.identity);
    assert.equal(initial.liveness.classification, 'observing');
    assert.equal(initial.liveness.nextObservationAt, '2026-08-26T18:02:00.000Z');

    timestamp += 2 * 60 * 1000;
    host.state.uptimeMilliseconds += 2 * 60 * 1000;
    host.state.diskAllocatedBytes += 8 * 1024 * 1024;
    const progressing = await construction.observeInstall(data.request.identity);
    assert.equal(progressing.liveness.classification, 'progressing');
    assert.equal(progressing.liveness.diskGrowthBytes, 8 * 1024 * 1024);

    timestamp += 21 * 60 * 1000;
    host.state.uptimeMilliseconds += 21 * 60 * 1000;
    const stalled = await construction.observeInstall(data.request.identity);
    assert.equal(stalled.liveness.classification, 'stalled');
    assert.equal(stalled.liveness.nextObservationAt, null);
    assert.equal(host.state.machineState, 'running');

    timestamp += 100 * 60 * 1000;
    host.state.uptimeMilliseconds += 100 * 60 * 1000;
    const overdue = await construction.observeInstall(data.request.identity);
    assert.equal(overdue.liveness.classification, 'overdue');
    assert.equal(host.state.machineState, 'running');
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

test('Hyper-V image construction binds an exact system-managed switch and resolves one private guest address', async () => {
  const data = await fixture();
  const host = fakeHost();
  const networkId = 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444';
  data.request.network = { control: 'system', reference: networkId, proof: networkId };
  try {
    const construction = constructor(data, host, '1'.repeat(32));
    await construction.prepare(data.request);
    const prepare = host.state.calls.find((entry) => entry.script.includes('construction media attachment count is incompatible'));
    assert.equal(prepare.payload.networkControl, 'system');
    assert.equal(prepare.payload.networkReference, networkId);
    assert.match(prepare.script, /Get-VMSwitch -Id/u);
    assert.match(prepare.script, /SwitchId/u);

    await construction.startInstall(data.request.identity);
    host.state.machineState = 'off';
    await construction.bootInstalled(data.request.identity);
    host.state.guestAddresses = ['fe80::1', '169.254.10.2', '172.27.17.42'];
    assert.deepEqual(await construction.connectionAddress(data.request.identity), { ready: true, reason: null, address: '172.27.17.42' });

    host.state.guestAddresses = [];
    assert.deepEqual(await construction.connectionAddress(data.request.identity), { ready: false, reason: 'construction guest has not reported a private IPv4 address', address: null });

    host.state.guestAddresses = ['10.0.0.2', '192.168.1.2'];
    await assert.rejects(() => construction.connectionAddress(data.request.identity), /ambiguous private IPv4/u);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('Windows Hyper-V construction reconciles only the exact default-adapter New-VM partial effect', { skip: process.platform !== 'win32' }, async () => {
  const data = await fixture();
  const networkId = 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444';
  data.request.network = { control: 'system', reference: networkId, proof: networkId };
  let prepareRequest;
  const providerIdentity = '11111111-2222-3333-4444-555555555555';
  try {
    const construction = constructor(data, {
      async invoke(request) {
        const script = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
        if (script.includes('construction media attachment count is incompatible')) {
          prepareRequest = request;
          return { exitCode: 0, stdout: JSON.stringify({ ready: true, providerIdentity }), stderr: '', timedOut: false, aborted: false, outputTruncated: false };
        }
        return { exitCode: 0, stdout: JSON.stringify({ exists: true, owned: true, state: 'off', providerIdentity, diskPresent: true, diskAttached: true, mediaCount: 2 }), stderr: '', timedOut: false, aborted: false, outputTruncated: false };
      },
    }, '2'.repeat(32));
    await construction.prepare(data.request);
    const prepareScript = Buffer.from(prepareRequest.arguments.at(-1), 'base64').toString('utf16le');
    assert.match(prepareScript, /New-VM[^\r\n]+-SwitchName \(\[string\]\$switch\.Name\)/u);
    assert.match(prepareScript, /ConfigurationLocation/u);

    const mocks = ({ foreignConfig = false, foreignAdapter = false } = {}) => String.raw`
function Import-Module { [CmdletBinding()] param([Parameter(Position=0)]$Name) }
$script:item = $null
$script:adapter = $null
$script:hard = @()
$script:dvd = @()
function Get-VMSwitch { [CmdletBinding()] param([guid]$Id, [string]$Name) [pscustomobject]@{ Id = [guid]'${networkId}'; Name = 'Default Switch'; Notes = ''; SwitchType = 'Internal' } }
function Get-VM {
  [CmdletBinding()] param([string]$Name)
  if ($null -eq $script:item) {
    $location = if (${foreignConfig ? '$true' : '$false'}) { Join-Path ([string]$data.configPath) 'foreign' } else { Join-Path ([string]$data.configPath) ([string]$data.name) }
    $script:item = [pscustomobject]@{ Name = [string]$data.name; Id = [guid]'${providerIdentity}'; Generation = 2; State = 'Off'; Notes = ''; MemoryStartup = [long]$data.memoryBytes; ConfigurationLocation = $location }
  }
  $script:item
}
function New-VM { [CmdletBinding()] param() throw 'existing exact partial was replaced' }
function Get-VMHardDiskDrive { [CmdletBinding()] param([string]$VMName) $script:hard }
function Get-VMDvdDrive {
  [CmdletBinding()] param([string]$VMName, [int]$ControllerNumber, [int]$ControllerLocation)
  if ($PSBoundParameters.ContainsKey('ControllerNumber') -and $PSBoundParameters.ContainsKey('ControllerLocation')) {
    $script:dvd | Where-Object { $_.ControllerNumber -eq $ControllerNumber -and $_.ControllerLocation -eq $ControllerLocation }
  } else { $script:dvd }
}
function Get-VMNetworkAdapter {
  [CmdletBinding()] param([string]$VMName)
  if ($null -eq $script:adapter) {
    $script:adapter = [pscustomobject]@{
      Name = 'Network Adapter'; IsLegacy = $false; DynamicMacAddressEnabled = $true
      Connected = ${foreignAdapter ? '$true' : '$false'}; SwitchName = ${foreignAdapter ? "'foreign'" : '$null'}; SwitchId = ${foreignAdapter ? "[guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'" : '$null'}
    }
  }
  $script:adapter
}
function Set-VM {
  [CmdletBinding()] param([string]$Name, [string]$Notes, [bool]$AutomaticCheckpointsEnabled, $AutomaticStartAction, $AutomaticStopAction, [long]$MemoryStartupBytes)
  if ($PSBoundParameters.ContainsKey('Notes')) { $script:item.Notes = $Notes }
}
function Set-VMProcessor { [CmdletBinding()] param([string]$VMName, [long]$Count) }
function Set-VMFirmware { [CmdletBinding()] param([string]$VMName, $EnableSecureBoot, $FirstBootDevice) }
function Add-VMNetworkAdapter { [CmdletBinding()] param() throw 'the default adapter was not reconciled' }
function Connect-VMNetworkAdapter {
  [CmdletBinding()] param($VMNetworkAdapter, $VMSwitch)
  if ([string]$script:item.Notes -ne [string]$data.marker) { throw 'network mutation preceded ownership proof' }
  $VMNetworkAdapter.Connected = $true; $VMNetworkAdapter.SwitchName = [string]$VMSwitch.Name; $VMNetworkAdapter.SwitchId = [guid]$VMSwitch.Id
}
function New-VHD { [CmdletBinding()] param([string]$Path, [switch]$Dynamic, [long]$SizeBytes) }
function Test-VHD { [CmdletBinding()] param([string]$Path) $true }
function Get-VHD { [CmdletBinding()] param([string]$Path) [pscustomobject]@{ VhdType = 'Dynamic'; ParentPath = $null; Size = [long]$data.diskBytes } }
function Add-VMHardDiskDrive {
  [CmdletBinding()] param([string]$VMName, [string]$ControllerType, [int]$ControllerNumber, [int]$ControllerLocation, [string]$Path)
  $script:hard = @([pscustomobject]@{ Path = $Path; ControllerNumber = $ControllerNumber; ControllerLocation = $ControllerLocation })
}
function Add-VMDvdDrive {
  [CmdletBinding()] param([string]$VMName, [int]$ControllerNumber, [int]$ControllerLocation, [string]$Path)
  $script:dvd += [pscustomobject]@{ Path = $Path; ControllerNumber = $ControllerNumber; ControllerLocation = $ControllerLocation }
}
`;
    const run = (mockScript) => invokeCommand({
      ...prepareRequest,
      arguments: [...prepareRequest.arguments.slice(0, -1), Buffer.from(`${mockScript}\n${prepareScript}`, 'utf16le').toString('base64')],
      timeoutMs: 20_000,
    });

    const exact = await run(mocks());
    assert.equal(exact.exitCode, 0, exact.stderr);
    assert.deepEqual(JSON.parse(exact.stdout), { ready: true, providerIdentity });

    const foreignConfig = await run(mocks({ foreignConfig: true }));
    assert.equal(foreignConfig.exitCode, 1);
    assert.match(foreignConfig.stderr, /occupied without matching ownership evidence/u);

    const foreignAdapter = await run(mocks({ foreignAdapter: true }));
    assert.equal(foreignAdapter.exitCode, 1);
    assert.match(foreignAdapter.stderr, /occupied without matching ownership evidence/u);
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

test('planned Hyper-V status reports an unowned partial without granting recovery authority', async () => {
  const data = await fixture();
  const host = fakeHost();
  try {
    const construction = constructor(data, host, '3'.repeat(32));
    host.state.failPrepare = true;
    await assert.rejects(() => construction.prepare(data.request), /interruption before partial reconciliation/u);

    host.state.exists = true;
    host.state.machineState = 'off';
    host.state.owned = false;
    const planned = await construction.status(data.request.identity);
    assert.equal(planned.phase, 'planned');
    assert.equal(planned.exists, true);
    assert.equal(planned.owned, false);

    const recovered = await construction.prepare(data.request);
    assert.equal(recovered.phase, 'prepared');
    assert.equal(recovered.owned, true);
    host.state.owned = false;
    await assert.rejects(() => construction.status(data.request.identity), /not owned/u);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});
