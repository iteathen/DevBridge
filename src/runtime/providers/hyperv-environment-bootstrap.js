import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/hyperv-environment-bootstrap-state-v1';
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const HOST_MIN = 10;
const HOST_MAX = 250;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function bounded(value, name, maxBytes = 4_096) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`);
  return value;
}

function targetId(value) {
  if (typeof value !== 'string' || !TARGET.test(value)) throw new TypeError('bootstrap target is invalid');
  return value;
}

function encodeScript(value) { return Buffer.from(value, 'utf16le').toString('base64'); }

function ipv4(value, name) {
  if (typeof value !== 'string' || !IPV4.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeNetwork(raw) {
  const network = requireObject(raw, 'bootstrap location.network');
  onlyKeys(network, new Set(['reference', 'proof', 'prefix', 'gateway']), 'bootstrap location.network');
  if (typeof network.reference !== 'string' || !REFERENCE.test(network.reference)) throw new TypeError('bootstrap network.reference is invalid');
  const prefix = bounded(network.prefix, 'bootstrap network.prefix', 64);
  const match = /^(\d+\.\d+\.\d+)\.0\/(\d{1,2})$/u.exec(prefix);
  if (!match || Number(match[2]) !== 24 || !IPV4.test(`${match[1]}.0`)) throw new TypeError('bootstrap network.prefix must be an IPv4 /24');
  return {
    reference: network.reference,
    proof: bounded(network.proof, 'bootstrap location.network.proof', 2_048),
    prefix,
    base: match[1],
    gateway: ipv4(network.gateway, 'bootstrap location.network.gateway'),
  };
}

function normalizeLocation(raw) {
  const value = requireObject(raw, 'bootstrap location');
  onlyKeys(value, new Set(['reference', 'proof', 'family', 'network']), 'bootstrap location');
  if (typeof value.reference !== 'string' || !REFERENCE.test(value.reference)) throw new TypeError('bootstrap location.reference is invalid');
  if (!['windows', 'linux'].includes(value.family)) throw new TypeError('bootstrap location.family is invalid');
  return {
    reference: value.reference,
    proof: bounded(value.proof, 'bootstrap location.proof', 2_048),
    family: value.family,
    network: normalizeNetwork(value.network),
  };
}

function normalizeConnection(raw, family) {
  const value = requireObject(raw, 'bootstrap connection');
  if (value.family !== family) throw new TypeError('bootstrap connection family changed');
  if (family === 'windows') {
    onlyKeys(value, new Set(['family', 'username', 'password']), 'bootstrap connection');
    return { family, username: bounded(value.username, 'bootstrap connection.username', 512), password: bounded(value.password, 'bootstrap connection.password', 16_384) };
  }
  onlyKeys(value, new Set(['family', 'user', 'identityFile', 'knownHostsFile']), 'bootstrap connection');
  return {
    family,
    user: bounded(value.user, 'bootstrap connection.user', 256),
    identityFile: bounded(value.identityFile, 'bootstrap connection.identityFile', 4_096),
    knownHostsFile: bounded(value.knownHostsFile, 'bootstrap connection.knownHostsFile', 4_096),
  };
}

function emptyState() { return { protocol: PROTOCOL, allocations: {} }; }

const PREPARE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.reference) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.proof) { throw 'environment ownership proof does not match' }
$switch = Get-VMSwitch -Name ([string]$data.networkReference) -ErrorAction Stop
if ([string]$switch.Notes -ne [string]$data.networkProof) { throw 'network ownership proof does not match' }
if ([string]$switch.SwitchType -ne 'Internal') { throw 'network switch type does not match' }
$adapters = @(Get-VMNetworkAdapter -VMName ([string]$data.reference) -ErrorAction Stop)
if ($adapters.Count -eq 0) {
  Add-VMNetworkAdapter -VMName ([string]$data.reference) -Name 'Network Adapter' -SwitchName ([string]$data.networkReference) -ErrorAction Stop | Out-Null
  $adapters = @(Get-VMNetworkAdapter -VMName ([string]$data.reference) -ErrorAction Stop)
}
if ($adapters.Count -ne 1) { throw 'environment network adapter count is incompatible' }
$adapter = $adapters[0]
if ([string]$adapter.SwitchName -ne [string]$data.networkReference) {
  Connect-VMNetworkAdapter -VMNetworkAdapter $adapter -VMSwitch $switch -ErrorAction Stop
}
$services = @(Get-VMIntegrationService -VMName ([string]$data.reference) -ErrorAction Stop)
$copy = $services | Where-Object { $_.Name -eq 'Guest Service Interface' } | Select-Object -First 1
if ($null -eq $copy) { throw 'guest file service is unavailable' }
if (-not $copy.Enabled) { Enable-VMIntegrationService -VMIntegrationService $copy -ErrorAction Stop | Out-Null }
@{ ready = $true; state = ([string]$item.State).ToLowerInvariant() } | ConvertTo-Json -Compress
`;

const COPY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.reference) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.proof) { throw 'environment ownership proof does not match' }
if ([string]$item.State -ne 'Running') { throw 'environment is not running' }
$service = Get-VMIntegrationService -VMName ([string]$data.reference) -ErrorAction Stop | Where-Object { $_.Name -eq 'Guest Service Interface' } | Select-Object -First 1
if ($null -eq $service -or -not $service.Enabled) { throw 'guest file service is not enabled' }
Copy-VMFile -VMName ([string]$data.reference) -SourcePath ([string]$data.source) -DestinationPath ([string]$data.destination) -FileSource Host -CreateFullPath -Force -ErrorAction Stop
@{ copied = $true } | ConvertTo-Json -Compress
`;

export class HyperVEnvironmentBootstrap {
  #directory;
  #stateFile;
  #guardFile;
  #invoke;
  #locate;
  #connection;
  #dnsServers;
  #tail = Promise.resolve();

  constructor({ directory, invoke, locate, connection, dnsServers = () => dns.getServers() }) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('bootstrap directory is required');
    if (typeof invoke !== 'function') throw new TypeError('bootstrap invoke must be a function');
    if (typeof locate !== 'function') throw new TypeError('bootstrap locate must be a function');
    if (typeof connection !== 'function') throw new TypeError('bootstrap connection must be a function');
    if (typeof dnsServers !== 'function') throw new TypeError('bootstrap dnsServers must be a function');
    this.#directory = path.resolve(directory);
    this.#stateFile = path.join(this.#directory, 'state.json');
    this.#guardFile = path.join(this.#directory, 'allocation.lock');
    this.#invoke = invoke;
    this.#locate = locate;
    this.#connection = connection;
    this.#dnsServers = dnsServers;
  }

  async #acquire() {
    await this.#ensure();
    const token = randomUUID();
    let handle;
    try {
      handle = await open(this.#guardFile, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('bootstrap allocation mutation is already active; remove allocation.lock only after confirming no operation is running');
      }
      throw error;
    }
    try {
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(this.#guardFile, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    return async () => {
      const observed = (await readFile(this.#guardFile, 'utf8')).trim();
      if (observed !== token) throw new Error('bootstrap allocation guard ownership changed');
      await rm(this.#guardFile);
    };
  }

  #serial(work) {
    const guarded = async () => {
      const release = await this.#acquire();
      try { return await work(); }
      finally { await release(); }
    };
    const next = this.#tail.then(guarded, guarded);
    this.#tail = next.catch(() => {});
    return next;
  }

  async #ensure() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('bootstrap directory must be a real directory');
  }

  async #load() {
    await this.#ensure();
    try {
      const info = await lstat(this.#stateFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('bootstrap state is invalid');
      const state = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (!state || state.protocol !== PROTOCOL || !state.allocations) throw new Error('bootstrap state protocol is invalid');
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

  async #powerShell(script, payload, timeoutMs = 45_000) {
    const result = await this.#invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodeScript(script)],
      input: JSON.stringify(payload),
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
    });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
      throw new Error(String(result?.stderr || result?.stdout || 'bootstrap management operation failed').trim().slice(0, 2_048));
    }
    try { return JSON.parse(result.stdout); } catch { throw new Error('bootstrap management operation returned invalid structured output'); }
  }

  #servers() {
    const servers = [...new Set(this.#dnsServers().filter((entry) => IPV4.test(entry)))].slice(0, 4);
    if (servers.length === 0) servers.push('1.1.1.1');
    return servers;
  }

  async #allocation(target, location, scope = 'managed') {
    return this.#serial(async () => {
      const state = await this.#load();
      const existing = state.allocations[target];
      if (existing) {
        if (existing.prefix !== location.network.prefix) throw new Error('bootstrap network identity changed for an existing target');
        const existingScope = existing.scope ?? 'managed';
        if (existingScope !== scope) throw new Error('bootstrap network allocation scope changed for an existing target');
        return existing.address;
      }
      const used = new Set(Object.values(state.allocations).filter((entry) => entry.prefix === location.network.prefix).map((entry) => entry.address));
      const width = HOST_MAX - HOST_MIN + 1;
      const start = Number.parseInt(createHash('sha256').update(target).digest('hex').slice(0, 8), 16) % width;
      let selected = null;
      for (let offset = 0; offset < width; offset += 1) {
        const host = HOST_MIN + ((start + offset) % width);
        const candidate = `${location.network.base}.${host}`;
        if (candidate !== location.network.gateway && !used.has(candidate)) { selected = candidate; break; }
      }
      if (!selected) throw new Error('bootstrap network address pool is exhausted');
      state.allocations[target] = { address: selected, prefix: location.network.prefix, scope, allocatedAt: new Date().toISOString() };
      await this.#save(state);
      return selected;
    });
  }

  async #resolved(target) {
    const location = normalizeLocation(await this.#locate(target));
    const baseConnection = normalizeConnection(await this.#connection(target), location.family);
    const address = await this.#allocation(target, location, 'managed');
    return { location, baseConnection, address };
  }

  async reserveAddress(rawTarget, rawNetwork) {
    const target = targetId(rawTarget);
    const network = normalizeNetwork(rawNetwork);
    const address = await this.#allocation(target, { network }, 'reserved');
    return Object.freeze({ address, prefixLength: 24, gateway: network.gateway, dns: Object.freeze(this.#servers()) });
  }

  async releaseAddress(rawTarget) {
    const target = targetId(rawTarget);
    return this.#serial(async () => {
      const state = await this.#load();
      const existing = state.allocations[target];
      if (!existing) return Object.freeze({ changed: false, absent: true });
      if ((existing.scope ?? 'managed') !== 'reserved') throw new Error('bootstrap managed network allocation cannot be released as a reservation');
      delete state.allocations[target];
      await this.#save(state);
      return Object.freeze({ changed: true, absent: false });
    });
  }

  async prepare(rawTarget) {
    const target = targetId(rawTarget);
    const { location } = await this.#resolved(target);
    const result = await this.#powerShell(PREPARE_SCRIPT, {
      reference: location.reference,
      proof: location.proof,
      networkReference: location.network.reference,
      networkProof: location.network.proof,
    }, 60_000);
    if (result.ready !== true) throw new Error('bootstrap preparation did not become ready');
    return { ready: true, cycleRequired: false };
  }

  async activate(rawTarget) {
    const target = targetId(rawTarget);
    const { location, address } = await this.#resolved(target);
    const seed = {
      protocol: 'devbridge/network-seed-v1',
      target,
      address,
      prefixLength: 24,
      gateway: location.network.gateway,
      dns: this.#servers(),
      revision: 1,
    };
    await this.#ensure();
    const temporary = path.join(this.#directory, `seed-${randomUUID()}.json`);
    await writeFile(temporary, `${JSON.stringify(seed)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      const destination = location.family === 'windows'
        ? 'C:\\ProgramData\\DevBridge\\bootstrap\\network-seed.json'
        : '/var/lib/devbridge/bootstrap/network-seed.json';
      const deadline = Date.now() + 90_000;
      let last = null;
      do {
        try {
          const result = await this.#powerShell(COPY_SCRIPT, { reference: location.reference, proof: location.proof, source: temporary, destination }, 20_000);
          if (result.copied === true) return { ready: true, address };
          last = new Error('guest seed copy did not report completion');
        } catch (error) {
          last = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      } while (Date.now() < deadline);
      throw new Error(`guest seed copy did not become ready: ${last?.message ?? 'unknown failure'}`);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async connection(rawTarget) {
    const target = targetId(rawTarget);
    const { location, baseConnection, address } = await this.#resolved(target);
    if (location.family === 'windows') return { ...baseConnection };
    return { ...baseConnection, address };
  }

  async reconcile(activeTargets = []) {
    if (!Array.isArray(activeTargets) || activeTargets.some((entry) => typeof entry !== 'string' || !TARGET.test(entry))) throw new TypeError('bootstrap active targets are invalid');
    return this.#serial(async () => {
      const state = await this.#load();
      const retained = new Set(activeTargets);
      let changed = false;
      for (const [key, entry] of Object.entries(state.allocations)) {
        if ((entry.scope ?? 'managed') === 'managed' && !retained.has(key)) { delete state.allocations[key]; changed = true; }
      }
      if (changed) await this.#save(state);
      return { changed, retained: Object.keys(state.allocations).length };
    });
  }
}
