import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { environmentInstanceDescriptor, environmentNetworkDescriptor } from './hyperv-environment-identity.js';

const STATE_PROTOCOL = 'devbridge/hyperv-environment-state-v1';
const TOKEN = /^[a-f0-9]{32}$/u;
const INSTANCE = /^[a-f0-9]{32,64}$/u;
const POWERSHELL = 'powershell.exe';
const COMMAND_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

function encodeScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function parseJson(result, action) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    const detail = result?.stderr?.trim() || result?.stdout?.trim() || `${action} failed`;
    throw new Error(detail.slice(0, 2_048));
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error(`${action} returned invalid structured output`); }
}

function emptyState() { return { protocol: STATE_PROTOCOL, network: null }; }

const CAPABILITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module Hyper-V -ErrorAction Stop
$required = @('Get-VMHost','Get-VM','Start-VM','Stop-VM','Remove-VM','Get-VHD','Test-VHD','Get-VMSwitch','New-VMSwitch','Set-VMSwitch','Remove-VMSwitch','Get-NetNat','New-NetNat','Remove-NetNat','Get-NetIPAddress','New-NetIPAddress','Remove-NetIPAddress','Get-NetIPInterface','Get-NetRoute')
foreach ($name in $required) { if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "required management operation is unavailable: $name" } }
$null = Get-VMHost -ErrorAction Stop
@{ ready = $true } | ConvertTo-Json -Compress
`;

const IMAGE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
if (-not (Test-VHD -Path $data.location -ErrorAction Stop)) { @{ usable = $false; reason = 'image chain is not usable' } | ConvertTo-Json -Compress; exit 0 }
$disk = Get-VHD -Path $data.location -ErrorAction Stop
@{
  usable = $true
  format = ([string]$disk.VhdFormat).ToLowerInvariant()
  contentIdentity = if ($null -eq $disk.DiskIdentifier) { $null } else { [string]$disk.DiskIdentifier }
  parentIdentity = if ([string]::IsNullOrWhiteSpace([string]$disk.ParentPath)) { $null } else { 'present' }
  virtualSize = [long]$disk.Size
} | ConvertTo-Json -Compress
`;

const NETWORK_INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$switch = Get-VMSwitch -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $switch) { @{ ready = $false; reason = 'owned network is absent' } | ConvertTo-Json -Compress; exit 0 }
if ([string]$switch.Notes -ne [string]$data.marker) { @{ ready = $false; reason = 'network ownership evidence does not match' } | ConvertTo-Json -Compress; exit 0 }
if ([string]$switch.SwitchType -ne 'Internal') { @{ ready = $false; reason = 'network switch type does not match' } | ConvertTo-Json -Compress; exit 0 }
$translations = @(Get-NetNat -ErrorAction Stop)
if ($translations.Count -ne 1) { @{ ready = $false; reason = 'network translation state does not match' } | ConvertTo-Json -Compress; exit 0 }
$nat = $translations[0]
if ([string]$nat.Name -ne [string]$data.name -or [string]$nat.InternalIPInterfaceAddressPrefix -ne [string]$data.prefix) { @{ ready = $false; reason = 'network translation state does not match' } | ConvertTo-Json -Compress; exit 0 }
$alias = "vEthernet ($($data.name))"
$address = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -eq $data.gateway -and $_.InterfaceAlias -eq $alias } | Select-Object -First 1
if ($null -eq $address) { @{ ready = $false; reason = 'network gateway address is absent' } | ConvertTo-Json -Compress; exit 0 }
@{ ready = $true } | ConvertTo-Json -Compress
`;

const NETWORK_ENSURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
function Convert-IPv4ToUInt32([string]$value) {
  $bytes = [System.Net.IPAddress]::Parse($value).GetAddressBytes()
  [Array]::Reverse($bytes)
  return [BitConverter]::ToUInt32($bytes, 0)
}
function Prefix-Overlaps([string]$candidate, [string]$existing) {
  if ($existing -notmatch '^([0-9.]+)/(\d+)$') { return $false }
  $existingAddress = $Matches[1]; $existingBits = [int]$Matches[2]
  if ($candidate -notmatch '^([0-9.]+)/(\d+)$') { return $true }
  $candidateAddress = $Matches[1]; $candidateBits = [int]$Matches[2]
  $bits = [Math]::Min($candidateBits, $existingBits)
  $hostBits = 32 - $bits
  $mask = if ($bits -eq 0) { [uint32]0 } else { [uint32]([uint64][uint32]::MaxValue - (([uint64]1 -shl $hostBits) - [uint64]1)) }
  return ((Convert-IPv4ToUInt32 $candidateAddress) -band $mask) -eq ((Convert-IPv4ToUInt32 $existingAddress) -band $mask)
}
$translations = @(Get-NetNat -ErrorAction Stop)
if ($translations.Count -gt 1) { throw 'host network translation state is ambiguous' }
$nat = $translations | Where-Object { [string]$_.Name -eq [string]$data.name } | Select-Object -First 1
if ($null -ne $nat -and [string]$nat.InternalIPInterfaceAddressPrefix -ne [string]$data.prefix) { throw 'network translation name is occupied with different state' }
if ($translations.Count -eq 1 -and $null -eq $nat) { throw 'another network translation already occupies the host' }
$switch = Get-VMSwitch -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $switch) {
  foreach ($route in (Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop)) {
    if ((Prefix-Overlaps $data.prefix ([string]$route.DestinationPrefix)) -and [string]$route.DestinationPrefix -ne '0.0.0.0/0') { throw 'selected private network overlaps an existing route' }
  }
  $switch = New-VMSwitch -Name $data.name -SwitchType Internal -ErrorAction Stop
  Set-VMSwitch -Name $data.name -Notes $data.marker -ErrorAction Stop
} elseif ([string]$switch.Notes -ne [string]$data.marker) {
  throw 'network name is occupied by an object without matching ownership evidence'
} elseif ([string]$switch.SwitchType -ne 'Internal') {
  throw 'owned network switch type does not match'
}
$alias = "vEthernet ($($data.name))"
$interface = $null
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  $interface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceAlias $alias -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $interface) { break }
  Start-Sleep -Milliseconds 250
}
if ($null -eq $interface) { throw 'owned network interface did not become ready' }
$address = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -eq $data.gateway -and $_.InterfaceAlias -eq $alias } | Select-Object -First 1
if ($null -eq $address) { $null = New-NetIPAddress -InterfaceIndex ([uint32]$interface.InterfaceIndex) -IPAddress $data.gateway -PrefixLength 24 -ErrorAction Stop }
if ($null -eq $nat) { $nat = New-NetNat -Name $data.name -InternalIPInterfaceAddressPrefix $data.prefix -ErrorAction Stop }
@{ ready = $true } | ConvertTo-Json -Compress
`;

const NETWORK_RELEASE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$switch = Get-VMSwitch -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -ne $switch -and [string]$switch.Notes -ne [string]$data.marker) { throw 'refusing to remove network without matching ownership evidence' }
$nat = Get-NetNat -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -ne $nat) {
  if ([string]$nat.InternalIPInterfaceAddressPrefix -ne [string]$data.prefix) { throw 'refusing to remove network translation with mismatched state' }
  Remove-NetNat -Name $data.name -Confirm:$false -ErrorAction Stop
}
$alias = "vEthernet ($($data.name))"
$address = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -eq $data.gateway -and $_.InterfaceAlias -eq $alias } | Select-Object -First 1
if ($null -ne $address) { Remove-NetIPAddress -InputObject $address -Confirm:$false -ErrorAction Stop }
if ($null -ne $switch) { Remove-VMSwitch -Name $data.name -Force -ErrorAction Stop }
@{ released = $true } | ConvertTo-Json -Compress
`;

const INSTANCE_OBSERVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $item) { @{ exists = $false; owned = $false; state = 'absent' } | ConvertTo-Json -Compress; exit 0 }
$owned = ([string]$item.Notes -eq [string]$data.marker)
@{ exists = $true; owned = $owned; state = ([string]$item.State).ToLowerInvariant() } | ConvertTo-Json -Compress
`;

const INSTANCE_START_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $item) { throw 'instance is absent' }
if ([string]$item.Notes -ne [string]$data.marker) { throw 'instance ownership evidence does not match' }
if ([string]$item.State -eq 'Off') { $item = Start-VM -Name $data.name -PassThru -ErrorAction Stop }
@{ exists = $true; owned = $true; state = ([string]$item.State).ToLowerInvariant() } | ConvertTo-Json -Compress
`;

const INSTANCE_STOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $item) { @{ exists = $false; owned = $false; state = 'absent' } | ConvertTo-Json -Compress; exit 0 }
if ([string]$item.Notes -ne [string]$data.marker) { throw 'instance ownership evidence does not match' }
if ([string]$item.State -ne 'Off') {
  try { Stop-VM -Name $data.name -Confirm:$false -ErrorAction Stop }
  catch { if ($data.force -eq $true) { Stop-VM -Name $data.name -TurnOff -Confirm:$false -ErrorAction Stop } else { throw } }
}
$item = Get-VM -Name $data.name -ErrorAction Stop
@{ exists = $true; owned = $true; state = ([string]$item.State).ToLowerInvariant() } | ConvertTo-Json -Compress
`;

const INSTANCE_REMOVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $data.name } | Select-Object -First 1
if ($null -eq $item) { @{ removed = $false; absent = $true } | ConvertTo-Json -Compress; exit 0 }
if ([string]$item.Notes -ne [string]$data.marker) { throw 'instance ownership evidence does not match' }
if ([string]$item.State -ne 'Off') { throw 'instance must be stopped before removal' }
Remove-VM -Name $data.name -Force -ErrorAction Stop
@{ removed = $true; absent = $false } | ConvertTo-Json -Compress
`;

export class HyperVEnvironment {
  #directory;
  #assetRoot;
  #identity;
  #invoke;
  #stateFile;

  constructor({ directory, assetRoot, identity, invoke }) {
    if (typeof identity !== 'string' || !TOKEN.test(identity)) throw new TypeError('environment identity is invalid');
    if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
    this.#directory = path.resolve(directory);
    this.#assetRoot = path.resolve(assetRoot);
    this.#identity = identity;
    this.#invoke = invoke;
    this.#stateFile = path.join(this.#directory, 'state.json');
  }

  async #ensure() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await mkdir(this.#assetRoot, { recursive: true, mode: 0o700 });
    for (const directory of [this.#directory, this.#assetRoot]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment control directories must be real directories');
    }
  }

  async #loadState() {
    await this.#ensure();
    try {
      const info = await lstat(this.#stateFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment control state must be a real file');
      const state = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (!state || state.protocol !== STATE_PROTOCOL) throw new Error('environment control state is invalid');
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async #saveState(state) {
    await this.#ensure();
    const temporary = path.join(this.#directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#stateFile);
  }

  async #run(script, payload = {}, timeoutMs = 20_000) {
    return parseJson(await this.#invoke({
      executable: POWERSHELL,
      arguments: [...COMMAND_ARGS, encodeScript(script)],
      input: JSON.stringify(payload),
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
    }), 'management operation');
  }

  async #safeAsset(location) {
    if (typeof location !== 'string' || location.length === 0 || location.includes('\0')) throw new TypeError('image location is invalid');
    const candidate = path.resolve(location);
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('image location must be a real regular file');
    const [root, actual] = await Promise.all([realpath(this.#assetRoot), realpath(candidate)]);
    const relative = path.relative(root, actual);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('image location is outside the managed asset root');
    }
    return actual;
  }

  async inspect() {
    let management;
    try {
      const observed = await this.#run(CAPABILITY_SCRIPT);
      management = observed.ready === true
        ? { state: 'ready', ready: true, reason: null }
        : { state: 'unavailable', ready: false, reason: 'management capability is unavailable' };
    } catch (error) {
      management = { state: 'unavailable', ready: false, reason: `management capability is unavailable: ${error.message}` };
    }

    let networking = { state: 'unavailable', ready: false, reason: 'owned network is not prepared' };
    let storage = { state: 'unavailable', ready: false, reason: 'managed storage is unavailable' };
    if (management.ready) {
      try {
        await this.#ensure();
        const rootInfo = await lstat(this.#assetRoot);
        storage = rootInfo.isDirectory() && !rootInfo.isSymbolicLink()
          ? { state: 'ready', ready: true, reason: null }
          : { state: 'degraded', ready: false, reason: 'managed storage root is not a real directory' };
      } catch (error) {
        storage = { state: 'degraded', ready: false, reason: `managed storage observation failed: ${error.message}` };
      }
      const state = await this.#loadState();
      if (state.network) {
        try {
          const observed = await this.#run(NETWORK_INSPECT_SCRIPT, state.network);
          networking = observed.ready === true
            ? { state: 'ready', ready: true, reason: null }
            : { state: 'degraded', ready: false, reason: String(observed.reason ?? 'owned network is not ready') };
        } catch (error) {
          networking = { state: 'degraded', ready: false, reason: `owned network observation failed: ${error.message}` };
        }
      }
    }
    return { identity: this.#identity, capabilities: { management, networking, storage } };
  }

  async inspectImage({ location }) {
    const safe = await this.#safeAsset(location);
    const observed = await this.#run(IMAGE_SCRIPT, { location: safe }, 30_000);
    if (observed.usable !== true) return { usable: false, reason: String(observed.reason ?? 'image media is unusable'), format: 'image', contentIdentity: null, parentIdentity: null, virtualSize: 1 };
    return {
      usable: true,
      format: String(observed.format).toLowerCase(),
      contentIdentity: observed.contentIdentity == null ? null : String(observed.contentIdentity),
      parentIdentity: observed.parentIdentity == null ? null : String(observed.parentIdentity),
      virtualSize: Number(observed.virtualSize),
    };
  }

  async ensureNetwork() {
    const state = await this.#loadState();
    if (!state.network) {
      const selected = environmentNetworkDescriptor(this.#identity);
      state.network = {
        phase: 'planned',
        ...selected,
      };
      await this.#saveState(state);
    }
    const observed = await this.#run(NETWORK_ENSURE_SCRIPT, state.network, 45_000);
    if (observed.ready !== true) throw new Error('owned network did not become ready');
    const latest = await this.#loadState();
    latest.network.phase = 'reconciled';
    await this.#saveState(latest);
    return { ready: true };
  }

  async releaseNetwork() {
    const state = await this.#loadState();
    if (!state.network) return { released: false, absent: true };
    const result = await this.#run(NETWORK_RELEASE_SCRIPT, state.network, 45_000);
    if (result.released !== true) throw new Error('owned network removal did not reconcile');
    state.network = null;
    await this.#saveState(state);
    return { released: true, absent: false };
  }

  async ensureStorage() {
    await mkdir(this.#assetRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#assetRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('managed storage root must be a real directory');
    return { ready: true };
  }

  async releaseStorage() {
    return { released: false, retained: true };
  }

  async reconcile() {
    const state = await this.#loadState();
    if (state.network?.phase === 'planned') await this.ensureNetwork();
    for (const name of await readdir(this.#directory)) {
      if (/^\.state-[a-f0-9-]+\.tmp$/u.test(name)) await rm(path.join(this.#directory, name), { force: true });
    }
    return this.inspect();
  }

  #instanceDescriptor(identity) {
    if (typeof identity !== 'string' || !INSTANCE.test(identity)) throw new TypeError('instance identity must be an opaque local token');
    return environmentInstanceDescriptor(this.#identity, identity);
  }

  async observeInstance(identity) {
    const observed = await this.#run(INSTANCE_OBSERVE_SCRIPT, this.#instanceDescriptor(identity));
    return { identity, exists: observed.exists === true, owned: observed.owned === true, state: String(observed.state ?? 'unknown') };
  }

  async startInstance(identity) {
    const observed = await this.#run(INSTANCE_START_SCRIPT, this.#instanceDescriptor(identity), 60_000);
    return { identity, exists: observed.exists === true, owned: observed.owned === true, state: String(observed.state ?? 'unknown') };
  }

  async stopInstance(identity, { force = false } = {}) {
    if (typeof force !== 'boolean') throw new TypeError('stop force must be boolean');
    const observed = await this.#run(INSTANCE_STOP_SCRIPT, { ...this.#instanceDescriptor(identity), force }, 90_000);
    return { identity, exists: observed.exists === true, owned: observed.owned === true, state: String(observed.state ?? 'unknown') };
  }

  async removeInstance(identity) {
    const observed = await this.#run(INSTANCE_REMOVE_SCRIPT, this.#instanceDescriptor(identity), 60_000);
    return { identity, removed: observed.removed === true, absent: observed.absent === true };
  }
}
