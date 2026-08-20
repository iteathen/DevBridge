import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const PROTOCOL = 'devbridge/network-seed-v1';
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const MAX_SEED_BYTES = 32 * 1024;
const POLL_MS = 1_000;

function seedPath() {
  if (process.env.DEVBRIDGE_NETWORK_SEED) return path.resolve(process.env.DEVBRIDGE_NETWORK_SEED);
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'DevBridge', 'bootstrap', 'network-seed.json');
  return '/var/lib/devbridge/bootstrap/network-seed.json';
}

function statePath() {
  if (process.env.DEVBRIDGE_NETWORK_STATE) return path.resolve(process.env.DEVBRIDGE_NETWORK_STATE);
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'DevBridge', 'bootstrap', 'network-state.json');
  return '/var/lib/devbridge/bootstrap/network-state.json';
}

const SEED = seedPath();
const STATE = statePath();

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function ipv4(value, name) {
  if (typeof value !== 'string' || !IPV4.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeSeed(raw) {
  const value = requireObject(raw, 'network seed');
  onlyKeys(value, new Set(['protocol', 'target', 'address', 'prefixLength', 'gateway', 'dns', 'revision']), 'network seed');
  if (value.protocol !== PROTOCOL) throw new TypeError('network seed protocol is invalid');
  if (typeof value.target !== 'string' || !TARGET.test(value.target)) throw new TypeError('network seed target is invalid');
  if (!Number.isInteger(value.prefixLength) || value.prefixLength < 8 || value.prefixLength > 30) throw new TypeError('network seed prefixLength is invalid');
  if (value.revision !== 1) throw new TypeError('network seed revision is invalid');
  if (!Array.isArray(value.dns) || value.dns.length === 0 || value.dns.length > 4) throw new TypeError('network seed dns is invalid');
  return {
    protocol: PROTOCOL,
    target: value.target,
    address: ipv4(value.address, 'network seed address'),
    prefixLength: value.prefixLength,
    gateway: ipv4(value.gateway, 'network seed gateway'),
    dns: [...new Set(value.dns.map((entry) => ipv4(entry, 'network seed dns entry')))],
    revision: 1,
  };
}

async function loadSeed() {
  const info = await lstat(SEED);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SEED_BYTES) throw new Error('network seed must be a bounded real file');
  return normalizeSeed(JSON.parse(await readFile(SEED, 'utf8')));
}

function digest(seed) {
  return createHash('sha256').update(JSON.stringify(seed), 'utf8').digest('hex');
}

function invoke(executable, args, { input = null, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    try {
      child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: process.env });
    } catch (error) { reject(error); return; }
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-16_384); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('network configuration operation timed out'));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error((stderr || stdout || `network configuration operation exited ${code}`).trim().slice(0, 2_048)));
      else resolve({ stdout, stderr });
    });
    if (input == null) child.stdin.end(); else child.stdin.end(input);
  });
}

function networkInterfaces() {
  const names = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (!name || name.toLowerCase().includes('loopback')) continue;
    if ((entries ?? []).some((entry) => entry.internal !== true)) names.push(name);
    else if ((entries ?? []).length === 0) names.push(name);
  }
  return [...new Set(names)];
}

async function linuxInterface() {
  const byNode = networkInterfaces();
  if (byNode.length === 1) return byNode[0];
  const { stdout } = await invoke('ip', ['-o', 'link', 'show']);
  const candidates = stdout.split(/\r?\n/u)
    .map((line) => line.match(/^\d+:\s+([^:@]+)(?:@[^:]+)?:/u)?.[1])
    .filter((name) => name && name !== 'lo');
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) throw new Error('network seed requires exactly one non-loopback interface');
  return unique[0];
}

async function applyLinux(seed) {
  const name = await linuxInterface();
  await invoke('ip', ['link', 'set', 'dev', name, 'up']);
  await invoke('ip', ['address', 'replace', `${seed.address}/${seed.prefixLength}`, 'dev', name]);
  await invoke('ip', ['route', 'replace', 'default', 'via', seed.gateway, 'dev', name]);
  try {
    await invoke('resolvectl', ['dns', name, ...seed.dns]);
    await invoke('resolvectl', ['domain', name, '~.']);
  } catch (error) {
    throw new Error(`network DNS configuration failed: ${error.message}`);
  }
}

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$adapters = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -ne 'Disabled' -and $_.HardwareInterface -eq $true })
if ($adapters.Count -ne 1) { throw 'network seed requires exactly one enabled hardware interface' }
$item = $adapters[0]
Get-NetIPAddress -InterfaceIndex $item.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -ne $data.address -and $_.PrefixOrigin -ne 'WellKnown' } |
  Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
$route = Get-NetRoute -InterfaceIndex $item.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue
if ($null -ne $route) { $route | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue }
$existing = Get-NetIPAddress -InterfaceIndex $item.ifIndex -AddressFamily IPv4 -IPAddress $data.address -ErrorAction SilentlyContinue
if ($null -eq $existing) {
  New-NetIPAddress -InterfaceIndex $item.ifIndex -IPAddress $data.address -PrefixLength ([int]$data.prefixLength) -DefaultGateway $data.gateway -ErrorAction Stop | Out-Null
}
Set-DnsClientServerAddress -InterfaceIndex $item.ifIndex -ServerAddresses @($data.dns) -ErrorAction Stop
`;

async function applyWindows(seed) {
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
  await invoke('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    input: JSON.stringify(seed),
    timeoutMs: 30_000,
  });
}

async function saveState(seed) {
  const directory = path.dirname(STATE);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('network state directory must be a real directory');
  const canonical = await realpath(directory);
  const temporary = path.join(canonical, `.network-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ protocol: PROTOCOL, target: seed.target, digest: digest(seed), appliedAt: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, STATE);
}

async function applySeed(seed) {
  if (process.platform === 'win32') await applyWindows(seed);
  else if (process.platform === 'linux') await applyLinux(seed);
  else throw new Error('network seed is unsupported on this guest platform');
  await saveState(seed);
}

async function currentState() {
  try { return JSON.parse(await readFile(STATE, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function applyCurrentNetworkSeed() {
  const seed = await loadSeed();
  const state = await currentState();
  if (state?.protocol === PROTOCOL && state.target === seed.target && state.digest === digest(seed)) return { changed: false, target: seed.target };
  await applySeed(seed);
  return { changed: true, target: seed.target };
}

if (process.argv.includes('--once')) {
  await applyCurrentNetworkSeed();
} else if (process.argv.includes('--watch')) {
  let last = null;
  while (true) {
    try {
      const seed = await loadSeed();
      const next = digest(seed);
      if (next !== last) {
        await applySeed(seed);
        last = next;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') process.stderr.write(`network seed apply failed: ${String(error?.message ?? error).slice(0, 2_048)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
