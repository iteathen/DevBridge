import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/hyperv-image-construction-v1';
const TOKEN = /^[a-f0-9]{32}$/u;
const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const MIN_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MIN_DISK_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DISK_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;

function encodeScript(script) { return Buffer.from(script, 'utf16le').toString('base64'); }
function emptyState() { return { protocol: PROTOCOL, records: {} }; }

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function subject(value) {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError('construction identity is invalid');
  return value;
}

function mediaIdentity(raw, name) {
  const value = onlyKeys(raw, new Set(['location', 'bytes', 'sha256']), name);
  if (typeof value.location !== 'string' || value.location.length === 0 || value.location.includes('\0')) throw new TypeError(`${name}.location is invalid`);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) throw new TypeError(`${name}.bytes is invalid`);
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) throw new TypeError(`${name}.sha256 is invalid`);
  return { location: value.location, bytes: value.bytes, sha256: value.sha256 };
}

function networkIdentity(raw) {
  const value = onlyKeys(raw, new Set(['reference', 'proof']), 'construction network');
  if (typeof value.reference !== 'string' || !REFERENCE.test(value.reference)) throw new TypeError('construction network.reference is invalid');
  if (typeof value.proof !== 'string' || value.proof.length === 0 || value.proof.length > 2048 || value.proof.includes('\0')) throw new TypeError('construction network.proof is invalid');
  return { reference: value.reference, proof: value.proof };
}

function normalizeRequest(raw) {
  const value = onlyKeys(raw, new Set(['identity', 'installer', 'seed', 'memoryBytes', 'processorCount', 'diskBytes', 'network']), 'construction request');
  return {
    identity: subject(value.identity),
    installer: mediaIdentity(value.installer, 'construction installer'),
    seed: mediaIdentity(value.seed, 'construction seed'),
    memoryBytes: boundedInteger(value.memoryBytes, MIN_MEMORY_BYTES, MAX_MEMORY_BYTES, 'construction memoryBytes'),
    processorCount: boundedInteger(value.processorCount, 1, MAX_PROCESSORS, 'construction processorCount'),
    diskBytes: boundedInteger(value.diskBytes, MIN_DISK_BYTES, MAX_DISK_BYTES, 'construction diskBytes'),
    network: networkIdentity(value.network),
  };
}

async function sha256File(location) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function pathInside(root, candidate) { return candidate.startsWith(`${root}${path.sep}`); }

function nameFor(identity, construction) {
  return `db-image-build-${createHash('sha256').update(`${identity}:${construction}`).digest('hex').slice(0, 16)}`;
}

function markerFor(identity, construction) {
  return `devbridge-owned:${identity}:image-build:${construction}:v1`;
}

function diskNameFor(identity, construction) {
  return `${createHash('sha256').update(`${identity}:image-disk:${construction}`).digest('hex')}.vhdx`;
}

function sameRequest(record, request) {
  return record.identity === request.identity
    && record.installer.sha256 === request.installer.sha256
    && record.installer.bytes === request.installer.bytes
    && record.seed.sha256 === request.seed.sha256
    && record.seed.bytes === request.seed.bytes
    && record.memoryBytes === request.memoryBytes
    && record.processorCount === request.processorCount
    && record.diskBytes === request.diskBytes
    && record.network.reference === request.network.reference
    && record.network.proof === request.network.proof;
}

function parseJson(result, name) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    const detail = String(result?.stderr || result?.stdout || `${name} failed`).trim().slice(0, 2048);
    throw new Error(detail || `${name} failed`);
  }
  try { return JSON.parse(String(result.stdout ?? '')); } catch { throw new Error(`${name} returned invalid structured output`); }
}

const PREPARE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
if (-not (Test-Path -LiteralPath $data.installerPath -PathType Leaf)) { throw 'installer media is absent' }
if (-not (Test-Path -LiteralPath $data.seedPath -PathType Leaf)) { throw 'seed media is absent' }
$switch = Get-VMSwitch -Name ([string]$data.networkReference) -ErrorAction Stop
if ([string]$switch.Notes -ne [string]$data.networkProof) { throw 'construction network ownership proof does not match' }
if ([string]$switch.SwitchType -ne 'Internal') { throw 'construction network type is incompatible' }
$null = New-Item -ItemType Directory -Path ([string]$data.configPath) -Force -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -eq $item) {
  $item = New-VM -Name ([string]$data.name) -Generation 2 -NoVHD -MemoryStartupBytes ([long]$data.memoryBytes) -Path ([string]$data.configPath) -ErrorAction Stop
}
if ([string]$item.State -ne 'Off') { throw 'construction machine must be stopped during preparation' }
if ([string]$item.Notes -ne [string]$data.marker) {
  $hard = @(Get-VMHardDiskDrive -VMName ([string]$data.name) -ErrorAction Stop)
  $dvd = @(Get-VMDvdDrive -VMName ([string]$data.name) -ErrorAction Stop)
  $net = @(Get-VMNetworkAdapter -VMName ([string]$data.name) -ErrorAction Stop)
  if (-not [string]::IsNullOrWhiteSpace([string]$item.Notes) -or $hard.Count -ne 0 -or $dvd.Count -ne 0 -or $net.Count -ne 0) {
    throw 'construction machine name is occupied without matching ownership evidence'
  }
  Set-VM -Name ([string]$data.name) -Notes ([string]$data.marker) -ErrorAction Stop
}
Set-VM -Name ([string]$data.name) -AutomaticCheckpointsEnabled $false -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -MemoryStartupBytes ([long]$data.memoryBytes) -ErrorAction Stop
Set-VMProcessor -VMName ([string]$data.name) -Count ([long]$data.processorCount) -ErrorAction Stop
Set-VMFirmware -VMName ([string]$data.name) -EnableSecureBoot Off -ErrorAction Stop
$nets = @(Get-VMNetworkAdapter -VMName ([string]$data.name) -ErrorAction Stop)
if ($nets.Count -eq 0) {
  Add-VMNetworkAdapter -VMName ([string]$data.name) -Name 'Network Adapter' -SwitchName ([string]$data.networkReference) -ErrorAction Stop | Out-Null
  $nets = @(Get-VMNetworkAdapter -VMName ([string]$data.name) -ErrorAction Stop)
}
if ($nets.Count -ne 1) { throw 'construction network adapter count is incompatible' }
if ([string]$nets[0].SwitchName -ne [string]$data.networkReference) { Connect-VMNetworkAdapter -VMNetworkAdapter $nets[0] -VMSwitch $switch -ErrorAction Stop }
if (-not (Test-Path -LiteralPath $data.diskPath -PathType Leaf)) {
  $null = New-VHD -Path ([string]$data.diskPath) -Dynamic -SizeBytes ([long]$data.diskBytes) -ErrorAction Stop
}
if (-not (Test-VHD -Path ([string]$data.diskPath) -ErrorAction Stop)) { throw 'construction disk is unusable' }
$disk = Get-VHD -Path ([string]$data.diskPath) -ErrorAction Stop
if ([string]$disk.VhdType -ne 'Dynamic' -or -not [string]::IsNullOrWhiteSpace([string]$disk.ParentPath) -or [long]$disk.Size -ne [long]$data.diskBytes) { throw 'construction disk shape does not match' }
$hard = @(Get-VMHardDiskDrive -VMName ([string]$data.name) -ErrorAction Stop)
if ($hard.Count -eq 0) {
  Add-VMHardDiskDrive -VMName ([string]$data.name) -ControllerType SCSI -ControllerNumber 0 -ControllerLocation 0 -Path ([string]$data.diskPath) -ErrorAction Stop
  $hard = @(Get-VMHardDiskDrive -VMName ([string]$data.name) -ErrorAction Stop)
}
if ($hard.Count -ne 1 -or [IO.Path]::GetFullPath([string]$hard[0].Path) -ne [IO.Path]::GetFullPath([string]$data.diskPath)) { throw 'construction disk attachment does not match' }
$dvd = @(Get-VMDvdDrive -VMName ([string]$data.name) -ErrorAction Stop)
$installer = $dvd | Where-Object { $_.ControllerNumber -eq 0 -and $_.ControllerLocation -eq 1 } | Select-Object -First 1
if ($null -eq $installer) { Add-VMDvdDrive -VMName ([string]$data.name) -ControllerNumber 0 -ControllerLocation 1 -Path ([string]$data.installerPath) -ErrorAction Stop; $installer = Get-VMDvdDrive -VMName ([string]$data.name) -ControllerNumber 0 -ControllerLocation 1 -ErrorAction Stop }
elseif ([IO.Path]::GetFullPath([string]$installer.Path) -ne [IO.Path]::GetFullPath([string]$data.installerPath)) { throw 'installer media attachment does not match' }
$seed = $dvd | Where-Object { $_.ControllerNumber -eq 0 -and $_.ControllerLocation -eq 2 } | Select-Object -First 1
if ($null -eq $seed) { Add-VMDvdDrive -VMName ([string]$data.name) -ControllerNumber 0 -ControllerLocation 2 -Path ([string]$data.seedPath) -ErrorAction Stop; $seed = Get-VMDvdDrive -VMName ([string]$data.name) -ControllerNumber 0 -ControllerLocation 2 -ErrorAction Stop }
elseif ([IO.Path]::GetFullPath([string]$seed.Path) -ne [IO.Path]::GetFullPath([string]$data.seedPath)) { throw 'seed media attachment does not match' }
$dvd = @(Get-VMDvdDrive -VMName ([string]$data.name) -ErrorAction Stop)
if ($dvd.Count -ne 2) { throw 'construction media attachment count is incompatible' }
Set-VMFirmware -VMName ([string]$data.name) -FirstBootDevice $installer -ErrorAction Stop
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
@{ ready = $true; providerIdentity = ([string]$item.Id).ToLowerInvariant() } | ConvertTo-Json -Compress
`;

const OBSERVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -eq $item) { @{ exists = $false; owned = $false; state = 'absent'; diskPresent = (Test-Path -LiteralPath $data.diskPath -PathType Leaf) } | ConvertTo-Json -Compress; exit 0 }
$owned = [string]$item.Notes -eq [string]$data.marker
@{ exists = $true; owned = $owned; state = ([string]$item.State).ToLowerInvariant(); providerIdentity = ([string]$item.Id).ToLowerInvariant(); diskPresent = (Test-Path -LiteralPath $data.diskPath -PathType Leaf) } | ConvertTo-Json -Compress
`;

const START_INSTALL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
if ([string]$item.State -eq 'Off') { Start-VM -Name ([string]$data.name) -ErrorAction Stop | Out-Null }
elseif ([string]$item.State -ne 'Running') { throw 'construction machine is not startable' }
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
@{ started = $true; state = ([string]$item.State).ToLowerInvariant() } | ConvertTo-Json -Compress
`;

const BOOT_INSTALLED_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
if ([string]$item.State -ne 'Off') { throw 'installer must finish and power off before installed boot' }
$hard = @(Get-VMHardDiskDrive -VMName ([string]$data.name) -ErrorAction Stop)
if ($hard.Count -ne 1 -or [IO.Path]::GetFullPath([string]$hard[0].Path) -ne [IO.Path]::GetFullPath([string]$data.diskPath)) { throw 'construction disk attachment does not match' }
Get-VMDvdDrive -VMName ([string]$data.name) -ErrorAction Stop | Remove-VMDvdDrive -ErrorAction Stop
Set-VMFirmware -VMName ([string]$data.name) -FirstBootDevice $hard[0] -ErrorAction Stop
Start-VM -Name ([string]$data.name) -ErrorAction Stop | Out-Null
@{ started = $true } | ConvertTo-Json -Compress
`;

const STOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -eq $item) { @{ stopped = $false; absent = $true } | ConvertTo-Json -Compress; exit 0 }
if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
if ([string]$item.State -ne 'Off') {
  if ($data.force -eq $true) { Stop-VM -Name ([string]$data.name) -TurnOff -Confirm:$false -ErrorAction Stop }
  else { Stop-VM -Name ([string]$data.name) -Shutdown -Confirm:$false -ErrorAction Stop }
}
@{ stopped = $true; absent = $false } | ConvertTo-Json -Compress
`;

const RETAIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.name) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
if (([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
if ([string]$item.State -ne 'Off') { throw 'construction machine must be stopped before image retention' }
if (-not (Test-VHD -Path ([string]$data.diskPath) -ErrorAction Stop)) { throw 'construction disk is unusable' }
$disk = Get-VHD -Path ([string]$data.diskPath) -ErrorAction Stop
if ([string]$disk.VhdType -ne 'Dynamic' -or -not [string]::IsNullOrWhiteSpace([string]$disk.ParentPath)) { throw 'construction disk is not a standalone image' }
Remove-VM -Name ([string]$data.name) -Force -ErrorAction Stop
@{ retained = $true; virtualBytes = [long]$disk.Size; allocatedBytes = [long]$disk.FileSize; diskIdentity = [string]$disk.DiskIdentifier } | ConvertTo-Json -Compress
`;

const DISCARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -ne $item) {
  if ([string]$item.Notes -ne [string]$data.marker) { throw 'construction machine ownership proof does not match' }
  if (-not [string]::IsNullOrWhiteSpace([string]$data.providerIdentity) -and ([string]$item.Id).ToLowerInvariant() -ne ([string]$data.providerIdentity).ToLowerInvariant()) { throw 'construction provider identity changed' }
  if ([string]$item.State -ne 'Off') { throw 'construction machine must be stopped before discard' }
  Remove-VM -Name ([string]$data.name) -Force -ErrorAction Stop
}
if (Test-Path -LiteralPath ([string]$data.diskPath) -PathType Leaf) { Remove-Item -LiteralPath ([string]$data.diskPath) -Force -ErrorAction Stop }
@{ discarded = $true } | ConvertTo-Json -Compress
`;

export class HyperVImageConstruction {
  #directory;
  #sourceRoot;
  #outputRoot;
  #identity;
  #invoke;
  #stateFile;

  constructor({ directory, sourceRoot, outputRoot, identity, invoke } = {}) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('construction state directory is required');
    if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) throw new TypeError('construction source root is required');
    if (typeof outputRoot !== 'string' || outputRoot.length === 0) throw new TypeError('construction output root is required');
    if (typeof identity !== 'string' || !TOKEN.test(identity)) throw new TypeError('construction provider identity is invalid');
    if (typeof invoke !== 'function') throw new TypeError('construction invoke must be a function');
    this.#directory = path.resolve(directory);
    this.#sourceRoot = path.resolve(sourceRoot);
    this.#outputRoot = path.resolve(outputRoot);
    this.#identity = identity;
    this.#invoke = invoke;
    this.#stateFile = path.join(this.#directory, 'state.json');
  }

  async #ensure() {
    for (const directory of [this.#directory, this.#sourceRoot, this.#outputRoot]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('construction control roots must be real directories');
    }
  }

  async #load() {
    await this.#ensure();
    try {
      const info = await lstat(this.#stateFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('construction state is invalid');
      const state = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (!state || state.protocol !== PROTOCOL || !state.records || typeof state.records !== 'object') throw new Error('construction state protocol is invalid');
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async #save(state) {
    await this.#ensure();
    const temporary = path.join(this.#directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#stateFile);
  }

  async #source(location, expected) {
    const lexical = path.resolve(location);
    const [root, actual] = await Promise.all([realpath(this.#sourceRoot), realpath(lexical)]);
    if (!pathInside(root, actual)) throw new Error('construction media is outside the owned source root');
    const info = await lstat(actual);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('construction media must be a real regular file');
    if (info.size !== expected.bytes) throw new Error('construction media byte count changed');
    if (await sha256File(actual) !== expected.sha256) throw new Error('construction media digest changed');
    return actual;
  }

  async #run(script, payload, timeoutMs = 90_000) {
    return parseJson(await this.#invoke({ executable: POWERSHELL, arguments: [...POWERSHELL_ARGS, encodeScript(script)], input: JSON.stringify(payload), timeoutMs, maxOutputBytes: 1024 * 1024 }), 'construction management operation');
  }

  #descriptor(record) {
    return {
      name: record.name,
      marker: record.marker,
      providerIdentity: record.providerIdentity ?? '',
      configPath: path.join(this.#outputRoot, `${record.key}-vm`),
      diskPath: path.join(this.#outputRoot, record.diskName),
    };
  }

  async prepare(rawRequest) {
    const request = normalizeRequest(rawRequest);
    await this.#ensure();
    const installerPath = await this.#source(request.installer.location, request.installer);
    const seedPath = await this.#source(request.seed.location, request.seed);
    const state = await this.#load();
    let record = state.records[request.identity];
    if (!record) {
      const key = createHash('sha256').update(`${this.#identity}:${request.identity}`).digest('hex').slice(0, 32);
      const diskName = diskNameFor(this.#identity, request.identity);
      const diskPath = path.join(this.#outputRoot, diskName);
      try { await lstat(diskPath); throw new Error('construction output already exists without durable intent'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      record = {
        identity: request.identity,
        key,
        name: nameFor(this.#identity, request.identity),
        marker: markerFor(this.#identity, request.identity),
        diskName,
        installer: { bytes: request.installer.bytes, sha256: request.installer.sha256, location: installerPath },
        seed: { bytes: request.seed.bytes, sha256: request.seed.sha256, location: seedPath },
        memoryBytes: request.memoryBytes,
        processorCount: request.processorCount,
        diskBytes: request.diskBytes,
        network: request.network,
        phase: 'planned',
        providerIdentity: null,
      };
      state.records[request.identity] = record;
      await this.#save(state);
    } else if (!sameRequest(record, request)) {
      throw new Error('construction request changed after durable intent');
    }

    if (record.phase !== 'planned' && record.phase !== 'prepared') return this.status(request.identity);
    const result = await this.#run(PREPARE_SCRIPT, {
      ...this.#descriptor(record),
      installerPath,
      seedPath,
      memoryBytes: record.memoryBytes,
      processorCount: record.processorCount,
      diskBytes: record.diskBytes,
      networkReference: record.network.reference,
      networkProof: record.network.proof,
    }, 120_000);
    if (result.ready !== true || typeof result.providerIdentity !== 'string') throw new Error('construction preparation did not become ready');
    record.providerIdentity = result.providerIdentity;
    record.phase = 'prepared';
    await this.#save(state);
    return this.status(request.identity);
  }

  async status(rawIdentity) {
    const identity = subject(rawIdentity);
    const state = await this.#load();
    const record = state.records[identity];
    if (!record) return { identity, phase: 'absent', exists: false, owned: false, state: 'absent', diskPresent: false };
    const observed = await this.#run(OBSERVE_SCRIPT, this.#descriptor(record), 30_000);
    if (observed.exists === true && observed.owned !== true) throw new Error('construction provider object is not owned by this operation');
    if (record.providerIdentity && observed.exists === true && observed.providerIdentity !== record.providerIdentity) throw new Error('construction provider identity changed');
    return {
      identity,
      phase: record.phase,
      exists: observed.exists === true,
      owned: observed.owned === true,
      state: String(observed.state ?? 'unknown'),
      diskPresent: observed.diskPresent === true,
    };
  }

  async startInstall(rawIdentity) {
    const identity = subject(rawIdentity);
    const state = await this.#load();
    const record = state.records[identity];
    if (!record || record.phase !== 'prepared' || !record.providerIdentity) throw new Error('construction is not prepared for installation');
    await this.#source(record.installer.location, record.installer);
    await this.#source(record.seed.location, record.seed);
    const result = await this.#run(START_INSTALL_SCRIPT, this.#descriptor(record), 60_000);
    if (result.started !== true) throw new Error('construction installer did not start');
    record.phase = 'installing';
    await this.#save(state);
    return this.status(identity);
  }

  async bootInstalled(rawIdentity) {
    const identity = subject(rawIdentity);
    const state = await this.#load();
    const record = state.records[identity];
    if (!record || record.phase !== 'installing' || !record.providerIdentity) throw new Error('construction is not awaiting installed boot');
    const observed = await this.status(identity);
    if (!observed.exists || observed.state !== 'off' || !observed.diskPresent) throw new Error('installer has not completed with a retained disk');
    const result = await this.#run(BOOT_INSTALLED_SCRIPT, this.#descriptor(record), 60_000);
    if (result.started !== true) throw new Error('installed construction did not start');
    record.phase = 'qualifying';
    await this.#save(state);
    return this.status(identity);
  }

  async stop(rawIdentity, { force = false } = {}) {
    const identity = subject(rawIdentity);
    if (typeof force !== 'boolean') throw new TypeError('construction stop force is invalid');
    const state = await this.#load();
    const record = state.records[identity];
    if (!record || !record.providerIdentity) throw new Error('construction is not materialized');
    const result = await this.#run(STOP_SCRIPT, { ...this.#descriptor(record), force }, 120_000);
    if (result.stopped !== true && result.absent !== true) throw new Error('construction stop did not reconcile');
    return this.status(identity);
  }

  async markQualified(rawIdentity, evidence) {
    const identity = subject(rawIdentity);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new TypeError('construction qualification evidence is invalid');
    const serialized = JSON.stringify(evidence);
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) throw new Error('construction qualification evidence is too large');
    const state = await this.#load();
    const record = state.records[identity];
    if (!record || record.phase !== 'qualifying') throw new Error('construction is not in qualification');
    const observed = await this.status(identity);
    if (!observed.exists || observed.state !== 'off') throw new Error('qualified construction must be shut down before acceptance');
    record.qualification = structuredClone(evidence);
    record.phase = 'qualified';
    await this.#save(state);
    return { identity, phase: record.phase, qualification: structuredClone(record.qualification) };
  }

  async retain(rawIdentity) {
    const identity = subject(rawIdentity);
    const state = await this.#load();
    const record = state.records[identity];
    if (!record || record.phase !== 'qualified' || !record.providerIdentity) throw new Error('construction is not qualified for retention');
    const result = await this.#run(RETAIN_SCRIPT, this.#descriptor(record), 60_000);
    if (result.retained !== true) throw new Error('construction disk was not retained');
    record.phase = 'retained';
    record.disk = { virtualBytes: Number(result.virtualBytes), allocatedBytes: Number(result.allocatedBytes), identity: String(result.diskIdentity ?? '') };
    await this.#save(state);
    return {
      identity,
      phase: record.phase,
      location: path.join(this.#outputRoot, record.diskName),
      qualification: structuredClone(record.qualification),
      disk: structuredClone(record.disk),
    };
  }

  async discard(rawIdentity) {
    const identity = subject(rawIdentity);
    const state = await this.#load();
    const record = state.records[identity];
    if (!record) return { identity, discarded: false, absent: true };
    const observed = await this.status(identity);
    if (observed.exists && observed.state !== 'off') throw new Error('construction must be stopped before discard');
    const result = await this.#run(DISCARD_SCRIPT, this.#descriptor(record), 60_000);
    if (result.discarded !== true) throw new Error('construction discard did not reconcile');
    delete state.records[identity];
    await this.#save(state);
    await rm(path.join(this.#outputRoot, `${record.key}-vm`), { recursive: true, force: true }).catch(() => {});
    return { identity, discarded: true, absent: false };
  }
}

export function createHyperVImageConstruction(options) {
  return new HyperVImageConstruction(options);
}
