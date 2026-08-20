import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STATE_PROTOCOL = 'devbridge/libvirt-environment-state-v1';
const TOKEN = /^[a-f0-9]{32}$/u;
const INSTANCE = /^[a-f0-9]{32,64}$/u;
const URI = 'qemu:///system';

function ownedName(identity, kind, value = '') {
  return `db-${kind}-${createHash('sha256').update(`${identity}:${kind}:${value}`).digest('hex').slice(0, 16)}`;
}

function deterministicUuid(identity, value) {
  const hex = createHash('sha256').update(`${identity}:${value}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function emptyState() { return { protocol: STATE_PROTOCOL, network: null, storage: null }; }

function ipToUInt(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) throw new Error('invalid IPv4 address');
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function maskToBits(mask) {
  let value = mask >>> 0;
  let bits = 0;
  while ((value & 0x80000000) !== 0) { bits += 1; value = (value << 1) >>> 0; }
  return bits;
}

function maskFor(bits) {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

function overlaps(aAddress, aBits, bAddress, bBits) {
  const bits = Math.min(aBits, bBits);
  const mask = maskFor(bits);
  return ((aAddress & mask) >>> 0) === ((bAddress & mask) >>> 0);
}

function hexLittleEndianIpv4(hex) {
  if (!/^[a-fA-F0-9]{8}$/u.test(hex)) throw new Error('invalid route address');
  const bytes = [0, 2, 4, 6].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return ((bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | bytes[0]) >>> 0;
}

async function occupiedNetworks() {
  const ranges = [];
  try {
    const text = await readFile('/proc/net/route', 'utf8');
    for (const line of text.trim().split(/\r?\n/u).slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 8) continue;
      const address = hexLittleEndianIpv4(fields[1]);
      const mask = hexLittleEndianIpv4(fields[7]);
      if (mask === 0) continue;
      ranges.push({ address: (address & mask) >>> 0, bits: maskToBits(mask) });
    }
  } catch {}
  for (const records of Object.values(os.networkInterfaces())) {
    for (const record of records ?? []) {
      if (record.family !== 'IPv4' || !record.address || !record.netmask) continue;
      try {
        const address = ipToUInt(record.address);
        const mask = ipToUInt(record.netmask);
        ranges.push({ address: (address & mask) >>> 0, bits: maskToBits(mask) });
      } catch {}
    }
  }
  return ranges;
}

async function selectPrefix(identity, additional = []) {
  const occupied = [...await occupiedNetworks(), ...additional];
  const digest = createHash('sha256').update(`${identity}:network`).digest();
  const start = digest[0] % 160;
  for (let offset = 0; offset < 160; offset += 1) {
    const third = 64 + ((start + offset) % 160);
    const base = `192.168.${third}.0`;
    const address = ipToUInt(base);
    if (occupied.every((range) => !overlaps(address, 24, range.address, range.bits))) {
      return {
        prefix: `${base}/24`,
        gateway: `192.168.${third}.1`,
        dhcpStart: `192.168.${third}.10`,
        dhcpEnd: `192.168.${third}.250`,
      };
    }
  }
  throw new Error('no collision-free private network could be selected');
}

function activeFromInfo(text) {
  const line = String(text).split(/\r?\n/u).find((entry) => /^\s*Active\s*:/iu.test(entry));
  return Boolean(line && /:\s*yes\s*$/iu.test(line));
}

function stateFromText(text) {
  return String(text).trim().split(/\r?\n/u)[0]?.trim().toLowerCase() || 'unknown';
}

export class LibvirtEnvironment {
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

  async #run(executable, argumentsList, { input = null, timeoutMs = 20_000, maxOutputBytes = 1024 * 1024 } = {}) {
    return this.#invoke({ executable, arguments: argumentsList, input, timeoutMs, maxOutputBytes });
  }

  async #require(executable, argumentsList, options = {}) {
    const result = await this.#run(executable, argumentsList, options);
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
      const detail = result?.stderr?.trim() || result?.stdout?.trim() || 'management operation failed';
      throw new Error(detail.slice(0, 2_048));
    }
    return result.stdout;
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

  async #networkObservation(record) {
    const names = (await this.#require('virsh', ['-c', URI, 'net-list', '--all', '--name'])).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (!names.includes(record.name)) return { ready: false, reason: 'owned network is absent', exists: false, owned: false, compatible: false };
    const info = await this.#require('virsh', ['-c', URI, 'net-info', record.name]);
    const uuid = (await this.#require('virsh', ['-c', URI, 'net-uuid', record.name])).trim();
    if (uuid !== record.uuid) return { ready: false, reason: 'network ownership evidence does not match', exists: true, owned: false, compatible: false };
    const xml = await this.#require('virsh', ['-c', URI, 'net-dumpxml', record.name]);
    if (!xml.includes(record.marker)) return { ready: false, reason: 'network ownership marker does not match', exists: true, owned: false, compatible: false };
    if (!new RegExp(`<forward\\s+[^>]*mode=['"]nat['"]`, 'u').test(xml)) return { ready: false, reason: 'network forwarding state does not match', exists: true, owned: true, compatible: false };
    if (!new RegExp(`<bridge\\s+[^>]*name=['"]${regexEscape(record.bridge)}['"]`, 'u').test(xml)) return { ready: false, reason: 'network bridge identity does not match', exists: true, owned: true, compatible: false };
    if (!new RegExp(`<ip\\s+[^>]*address=['"]${regexEscape(record.gateway)}['"]`, 'u').test(xml)) return { ready: false, reason: 'network gateway state does not match', exists: true, owned: true, compatible: false };
    if (!activeFromInfo(info)) return { ready: false, reason: 'owned network is inactive', exists: true, owned: true, compatible: true };
    return { ready: true, reason: null, exists: true, owned: true, compatible: true };
  }

  async #storageObservation(record) {
    const names = (await this.#require('virsh', ['-c', URI, 'pool-list', '--all', '--name'])).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (!names.includes(record.name)) return { ready: false, reason: 'owned storage registration is absent', exists: false, owned: false, compatible: false };
    const info = await this.#require('virsh', ['-c', URI, 'pool-info', record.name]);
    const uuid = (await this.#require('virsh', ['-c', URI, 'pool-uuid', record.name])).trim();
    if (uuid !== record.uuid) return { ready: false, reason: 'storage ownership evidence does not match', exists: true, owned: false, compatible: false };
    const xml = await this.#require('virsh', ['-c', URI, 'pool-dumpxml', record.name]);
    if (!/<pool\s+[^>]*type=['"]dir['"]/u.test(xml)) return { ready: false, reason: 'storage type does not match', exists: true, owned: true, compatible: false };
    if (!xml.includes(`<path>${xmlEscape(record.target)}</path>`)) return { ready: false, reason: 'storage target does not match', exists: true, owned: true, compatible: false };
    if (!activeFromInfo(info)) return { ready: false, reason: 'owned storage registration is inactive', exists: true, owned: true, compatible: true };
    return { ready: true, reason: null, exists: true, owned: true, compatible: true };
  }

  async #providerNetworkRanges() {
    const names = (await this.#require('virsh', ['-c', URI, 'net-list', '--all', '--name'])).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    const ranges = [];
    for (const name of names) {
      const xml = await this.#require('virsh', ['-c', URI, 'net-dumpxml', name]);
      for (const match of xml.matchAll(/<ip\s+[^>]*address=['"]([0-9.]+)['"][^>]*netmask=['"]([0-9.]+)['"]/gu)) {
        try {
          const address = ipToUInt(match[1]);
          const mask = ipToUInt(match[2]);
          ranges.push({ address: (address & mask) >>> 0, bits: maskToBits(mask) });
        } catch {}
      }
    }
    return ranges;
  }

  async inspect() {
    let management;
    try {
      await access('/dev/kvm', fsConstants.R_OK | fsConstants.W_OK);
      const reportedUri = (await this.#require('virsh', ['-c', URI, 'uri'])).trim();
      if (reportedUri !== URI) throw new Error('management connection identity changed');
      const capabilities = await this.#require('virsh', ['-c', URI, 'capabilities'], { maxOutputBytes: 2 * 1024 * 1024 });
      if (!/<domain\s+type=['"]kvm['"]/u.test(capabilities)) throw new Error('hardware acceleration is not exposed by the management connection');
      await this.#require('qemu-img', ['--version']);
      management = { state: 'ready', ready: true, reason: null };
    } catch (error) {
      management = { state: 'unavailable', ready: false, reason: `management capability is unavailable: ${error.message}` };
    }

    let networking = { state: 'unavailable', ready: false, reason: 'owned network is not prepared' };
    let storage = { state: 'unavailable', ready: false, reason: 'owned storage registration is not prepared' };
    if (management.ready) {
      const state = await this.#loadState();
      if (state.network) {
        try {
          const observed = await this.#networkObservation(state.network);
          networking = observed.ready
            ? { state: 'ready', ready: true, reason: null }
            : { state: 'degraded', ready: false, reason: observed.reason };
        } catch (error) {
          networking = { state: 'degraded', ready: false, reason: `owned network observation failed: ${error.message}` };
        }
      }
      if (state.storage) {
        try {
          const observed = await this.#storageObservation(state.storage);
          storage = observed.ready
            ? { state: 'ready', ready: true, reason: null }
            : { state: 'degraded', ready: false, reason: observed.reason };
        } catch (error) {
          storage = { state: 'degraded', ready: false, reason: `owned storage observation failed: ${error.message}` };
        }
      }
    }
    return { identity: this.#identity, capabilities: { management, networking, storage } };
  }

  async inspectImage({ location }) {
    const safe = await this.#safeAsset(location);
    let parsed;
    try {
      const output = await this.#require('qemu-img', ['info', '--output=json', '--backing-chain', safe], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 });
      parsed = JSON.parse(output);
    } catch (error) {
      return { usable: false, reason: `image media inspection failed: ${error.message}`, format: 'image', contentIdentity: null, parentIdentity: null, virtualSize: 1 };
    }
    const chain = Array.isArray(parsed) ? parsed : [parsed];
    const head = chain[0];
    if (!head || chain.length !== 1 || head['backing-filename'] || head['full-backing-filename']) {
      return { usable: false, reason: 'base image must not contain a backing parent', format: String(head?.format ?? 'image'), contentIdentity: null, parentIdentity: 'present', virtualSize: Number(head?.['virtual-size'] ?? 1) };
    }
    if (String(head.format).toLowerCase() !== 'qcow2') {
      return { usable: false, reason: 'base image format is not supported by this environment control', format: String(head.format ?? 'image'), contentIdentity: null, parentIdentity: null, virtualSize: Number(head['virtual-size'] ?? 1) };
    }
    return { usable: true, format: 'qcow2', contentIdentity: null, parentIdentity: null, virtualSize: Number(head['virtual-size']) };
  }

  async ensureNetwork() {
    const state = await this.#loadState();
    if (!state.network) {
      const selected = await selectPrefix(this.#identity, await this.#providerNetworkRanges());
      state.network = {
        phase: 'planned',
        name: ownedName(this.#identity, 'network'),
        uuid: randomUUID(),
        marker: `devbridge-owned:${this.#identity}:network:v1`,
        bridge: `db${createHash('sha256').update(`${this.#identity}:bridge`).digest('hex').slice(0, 8)}`,
        ...selected,
      };
      await this.#saveState(state);
    }
    const record = state.network;
    const existing = await this.#networkObservation(record);
    if (existing.exists && (!existing.owned || !existing.compatible)) throw new Error(existing.reason ?? 'existing network is not owned');
    if (!existing.exists) {
      const xml = `<network><name>${xmlEscape(record.name)}</name><uuid>${record.uuid}</uuid><metadata><owner xmlns="urn:devbridge:ownership">${xmlEscape(record.marker)}</owner></metadata><forward mode="nat"/><bridge name="${record.bridge}" stp="on" delay="0"/><ip address="${record.gateway}" netmask="255.255.255.0"><dhcp><range start="${record.dhcpStart}" end="${record.dhcpEnd}"/></dhcp></ip></network>`;
      const file = path.join(this.#directory, `network-${record.uuid}.xml`);
      await writeFile(file, xml, { encoding: 'utf8', mode: 0o600 });
      try { await this.#require('virsh', ['-c', URI, 'net-define', file]); }
      finally { await rm(file, { force: true }); }
    }
    await this.#require('virsh', ['-c', URI, 'net-autostart', record.name]);
    const info = await this.#run('virsh', ['-c', URI, 'net-info', record.name]);
    if (!activeFromInfo(info.stdout)) await this.#require('virsh', ['-c', URI, 'net-start', record.name]);
    const observed = await this.#networkObservation(record);
    if (!observed.ready) throw new Error(observed.reason ?? 'owned network did not become ready');
    const latest = await this.#loadState();
    latest.network.phase = 'reconciled';
    await this.#saveState(latest);
    return { ready: true };
  }

  async releaseNetwork() {
    const state = await this.#loadState();
    if (!state.network) return { released: false, absent: true };
    const record = state.network;
    const observed = await this.#networkObservation(record);
    if (observed.exists && !observed.owned) throw new Error('refusing to remove network without matching ownership evidence');
    if (observed.exists) {
      const info = await this.#run('virsh', ['-c', URI, 'net-info', record.name]);
      if (activeFromInfo(info.stdout)) await this.#require('virsh', ['-c', URI, 'net-destroy', record.name]);
      await this.#require('virsh', ['-c', URI, 'net-undefine', record.name]);
    }
    state.network = null;
    await this.#saveState(state);
    return { released: true, absent: !observed.exists };
  }

  async ensureStorage() {
    const state = await this.#loadState();
    if (!state.storage) {
      state.storage = {
        phase: 'planned',
        name: ownedName(this.#identity, 'storage'),
        uuid: randomUUID(),
        target: await realpath(this.#assetRoot),
      };
      await this.#saveState(state);
    }
    const record = state.storage;
    const existing = await this.#storageObservation(record);
    if (existing.exists && (!existing.owned || !existing.compatible)) throw new Error(existing.reason ?? 'existing storage registration is not owned');
    if (!existing.exists) {
      const names = (await this.#require('virsh', ['-c', URI, 'pool-list', '--all', '--name'])).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
      for (const name of names) {
        if (name === record.name) continue;
        const foreignXml = await this.#require('virsh', ['-c', URI, 'pool-dumpxml', name]);
        if (foreignXml.includes(`<path>${xmlEscape(record.target)}</path>`)) throw new Error('managed storage target is already registered by an unowned object');
      }
      const xml = `<pool type="dir"><name>${xmlEscape(record.name)}</name><uuid>${record.uuid}</uuid><target><path>${xmlEscape(record.target)}</path></target></pool>`;
      const file = path.join(this.#directory, `storage-${record.uuid}.xml`);
      await writeFile(file, xml, { encoding: 'utf8', mode: 0o600 });
      try { await this.#require('virsh', ['-c', URI, 'pool-define', file]); }
      finally { await rm(file, { force: true }); }
    }
    await this.#require('virsh', ['-c', URI, 'pool-autostart', record.name]);
    const info = await this.#run('virsh', ['-c', URI, 'pool-info', record.name]);
    if (!activeFromInfo(info.stdout)) await this.#require('virsh', ['-c', URI, 'pool-start', record.name]);
    await this.#require('virsh', ['-c', URI, 'pool-refresh', record.name]);
    const observed = await this.#storageObservation(record);
    if (!observed.ready) throw new Error(observed.reason ?? 'owned storage registration did not become ready');
    const latest = await this.#loadState();
    latest.storage.phase = 'reconciled';
    await this.#saveState(latest);
    return { ready: true };
  }

  async releaseStorage() {
    const state = await this.#loadState();
    if (!state.storage) return { released: false, absent: true };
    const record = state.storage;
    const observed = await this.#storageObservation(record);
    if (observed.exists && !observed.owned) throw new Error('refusing to remove storage registration without matching ownership evidence');
    if (observed.exists) {
      const info = await this.#run('virsh', ['-c', URI, 'pool-info', record.name]);
      if (activeFromInfo(info.stdout)) await this.#require('virsh', ['-c', URI, 'pool-destroy', record.name]);
      await this.#require('virsh', ['-c', URI, 'pool-undefine', record.name]);
    }
    state.storage = null;
    await this.#saveState(state);
    return { released: true, absent: !observed.exists };
  }

  async reconcile() {
    const state = await this.#loadState();
    if (state.storage?.phase === 'planned') await this.ensureStorage();
    if (state.network?.phase === 'planned') await this.ensureNetwork();
    for (const name of await import('node:fs/promises').then(({ readdir }) => readdir(this.#directory))) {
      if (/^(network|storage)-[a-f0-9-]+\.xml$/u.test(name)) await rm(path.join(this.#directory, name), { force: true });
      if (/^\.state-[a-f0-9-]+\.tmp$/u.test(name)) await rm(path.join(this.#directory, name), { force: true });
    }
    return this.inspect();
  }

  #instanceDescriptor(identity) {
    if (typeof identity !== 'string' || !INSTANCE.test(identity)) throw new TypeError('instance identity must be an opaque local token');
    return {
      name: ownedName(this.#identity, 'instance', identity),
      uuid: deterministicUuid(this.#identity, `instance:${identity}`),
    };
  }

  async #instanceObservation(identity) {
    const descriptor = this.#instanceDescriptor(identity);
    const names = (await this.#require('virsh', ['-c', URI, 'list', '--all', '--name'])).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (!names.includes(descriptor.name)) return { identity, exists: false, owned: false, state: 'absent', descriptor };
    const state = await this.#require('virsh', ['-c', URI, 'domstate', descriptor.name, '--reason']);
    const uuid = (await this.#require('virsh', ['-c', URI, 'domuuid', descriptor.name])).trim();
    return { identity, exists: true, owned: uuid === descriptor.uuid, state: stateFromText(state), descriptor };
  }

  async observeInstance(identity) {
    const observed = await this.#instanceObservation(identity);
    const { descriptor: _descriptor, ...publicObservation } = observed;
    return publicObservation;
  }

  async startInstance(identity) {
    const observed = await this.#instanceObservation(identity);
    if (!observed.exists) throw new Error('instance is absent');
    if (!observed.owned) throw new Error('instance ownership evidence does not match');
    if (!['running', 'blocked'].includes(observed.state)) await this.#require('virsh', ['-c', URI, 'start', observed.descriptor.name], { timeoutMs: 60_000 });
    return this.observeInstance(identity);
  }

  async stopInstance(identity, { force = false, timeoutMs = 60_000 } = {}) {
    if (typeof force !== 'boolean') throw new TypeError('stop force must be boolean');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new TypeError('stop timeoutMs is invalid');
    let observed = await this.#instanceObservation(identity);
    if (!observed.exists) return { identity, exists: false, owned: false, state: 'absent' };
    if (!observed.owned) throw new Error('instance ownership evidence does not match');
    if (!['shut off', 'shutdown', 'crashed'].includes(observed.state)) {
      await this.#require('virsh', ['-c', URI, 'shutdown', observed.descriptor.name], { timeoutMs: 20_000 });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        observed = await this.#instanceObservation(identity);
        if (!observed.exists || ['shut off', 'shutdown', 'crashed'].includes(observed.state)) break;
      }
      if (observed.exists && !['shut off', 'shutdown', 'crashed'].includes(observed.state)) {
        if (!force) throw new Error('instance did not stop within the bounded wait');
        await this.#require('virsh', ['-c', URI, 'destroy', observed.descriptor.name], { timeoutMs: 20_000 });
      }
    }
    return this.observeInstance(identity);
  }

  async removeInstance(identity) {
    const observed = await this.#instanceObservation(identity);
    if (!observed.exists) return { identity, removed: false, absent: true };
    if (!observed.owned) throw new Error('instance ownership evidence does not match');
    if (!['shut off', 'shutdown', 'crashed'].includes(observed.state)) throw new Error('instance must be stopped before removal');
    const xml = await this.#require('virsh', ['-c', URI, 'dumpxml', observed.descriptor.name]);
    const args = xml.includes('<nvram')
      ? ['-c', URI, 'undefine', observed.descriptor.name, '--nvram']
      : ['-c', URI, 'undefine', observed.descriptor.name];
    await this.#require('virsh', args, { timeoutMs: 30_000 });
    return { identity, removed: true, absent: false };
  }
}
