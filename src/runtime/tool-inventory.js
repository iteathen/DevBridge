import { createHash } from 'node:crypto';
import process from 'node:process';
import { validateToolProfile } from './cli-profile.js';
import { discoverPathTools } from './tool-discovery.js';
import { resolveExecutable } from './executable-resolver.js';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function sanitizeToolchain(entry) {
  return {
    name: entry.name,
    available: entry.available === true,
    layer: entry.layer ?? 'core',
    family: entry.family ?? entry.name,
    version: typeof entry.version === 'string' ? entry.version.slice(0, 240) : null,
    source: typeof entry.source === 'string' ? entry.source.slice(0, 80) : null,
    health: entry.available === true ? 'available' : 'unavailable',
    errorClass: entry.available === true ? null : 'discovery-failed',
  };
}

function sanitizeDiscovered(entry) {
  return {
    name: entry.name,
    category: entry.category,
    available: entry.available === true,
    healthy: entry.healthy === true,
    version: typeof entry.version === 'string' ? entry.version.slice(0, 240) : null,
    source: entry.available ? 'PATH' : null,
  };
}

export class ToolInventoryService {
  #operations;
  #toolchains;
  #sandbox;
  #profiles;
  #modelAdaptersEnabled;
  #allowUncontained;
  #env;
  #discover;
  #current;
  #generation;

  constructor({
    operationRegistry,
    toolchainRegistry,
    sandboxProvider,
    profiles = {},
    modelAdaptersEnabled = false,
    allowUncontainedTools = false,
    env = process.env,
    discoverPathToolsEnabled = true,
  }) {
    this.#operations = operationRegistry;
    this.#toolchains = toolchainRegistry;
    this.#sandbox = sandboxProvider;
    this.#profiles = profiles;
    this.#modelAdaptersEnabled = modelAdaptersEnabled === true;
    this.#allowUncontained = allowUncontainedTools === true;
    this.#env = env;
    this.#discover = discoverPathToolsEnabled === true;
    this.#current = null;
    this.#generation = 0;
  }

  current() { return this.#current ? structuredClone(this.#current) : null; }

  async #adapterInventory(sandboxStatus) {
    const entries = [];
    for (const [name, raw] of Object.entries(this.#profiles)) {
      let profile;
      try { profile = validateToolProfile(name, raw, { allowUncontainedTools: this.#allowUncontained }); }
      catch (error) {
        entries.push({ name, enabled: false, available: false, usable: false, errorClass: error.name, inputMode: null, declaredPolicy: null, enforcement: sandboxStatus });
        continue;
      }
      let available = false;
      try { await resolveExecutable(profile.executable, this.#env); available = true; }
      catch { available = false; }
      const containmentSatisfied = profile.sandbox.requiresVerifiedSandbox === false ? this.#allowUncontained : sandboxStatus.verified === true;
      entries.push({
        name,
        enabled: this.#modelAdaptersEnabled,
        available,
        usable: this.#modelAdaptersEnabled && available && containmentSatisfied,
        inputMode: profile.inputMode,
        declaredPolicy: profile.sandbox,
        enforcement: sandboxStatus,
        errorClass: available ? null : 'executable-unavailable',
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async refresh({ probeVersions = false } = {}) {
    const sandboxStatus = this.#sandbox?.inspect?.() ?? { provider: 'none', configured: false, verified: false, verification: 'unavailable' };
    const toolchains = (await this.#toolchains.inspect()).map(sanitizeToolchain);
    const discovery = this.#discover
      ? await discoverPathTools({ env: this.#env, probeVersions })
      : { tools: [], discoveryElapsedMs: 0 };
    const normalized = {
      protocol: 'patch-poller/tool-inventory-v1',
      runtime: {
        family: 'patch-poller',
        version: '0.1.0',
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      sandbox: sandboxStatus,
      operations: this.#operations.describe({ sandboxStatus }),
      toolchains,
      adapters: await this.#adapterInventory(sandboxStatus),
      discoveredTools: discovery.tools.map(sanitizeDiscovered),
    };
    const inventoryDigest = digest(normalized);
    if (this.#current?.digest === inventoryDigest) return this.current();
    this.#generation += 1;
    this.#current = {
      protocol: 'patch-poller/tool-inventory-record-v1',
      digest: inventoryDigest,
      generation: this.#generation,
      generatedAt: new Date().toISOString(),
      discoveryElapsedMs: discovery.discoveryElapsedMs,
      inventory: normalized,
    };
    return this.current();
  }
}

export function toolInventoryDigest(inventory) {
  return digest(inventory);
}
