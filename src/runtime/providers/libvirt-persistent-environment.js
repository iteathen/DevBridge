import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/libvirt-persistent-environment-v1';
const TOKEN = /^[a-f0-9]{32}$/u;
const ENVIRONMENT = /^env-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const URI = 'qemu:///system';
const MIN_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_PROCESSORS = 256;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function normalizeSettings(raw) {
  const value = requireObject(raw, 'environment settings');
  onlyKeys(value, new Set(['memoryBytes', 'processorCount', 'firmware']), 'environment settings');
  if (!Number.isSafeInteger(value.memoryBytes) || value.memoryBytes < MIN_MEMORY_BYTES || value.memoryBytes > MAX_MEMORY_BYTES) throw new TypeError('environment settings.memoryBytes is invalid');
  if (!Number.isSafeInteger(value.processorCount) || value.processorCount < 1 || value.processorCount > MAX_PROCESSORS) throw new TypeError('environment settings.processorCount is invalid');
  if (!['efi', 'bios'].includes(value.firmware)) throw new TypeError('environment settings.firmware is invalid');
  return { memoryBytes: value.memoryBytes, processorCount: value.processorCount, firmware: value.firmware };
}

function emptyState() { return { protocol: PROTOCOL, records: {} }; }

function bindingIdentity(identity) {
  return createHash('sha256').update(`${identity}:persistent-environment:libvirt:v1`).digest('hex').slice(0, 32);
}

function ownedName(identity, value) {
  return `db-env-${createHash('sha256').update(`${identity}:persistent:${value}`).digest('hex').slice(0, 16)}`;
}

function deterministicUuid(identity, value) {
  const hex = createHash('sha256').update(`${identity}:persistent:${value}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function marker(identity, value) {
  return `devbridge-owned:${identity}:persistent:${value}:v1`;
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function stateFromText(text) {
  const first = String(text).trim().split(/\r?\n/u)[0]?.trim().toLowerCase() || 'unknown';
  return first.replace(/\s+\([^)]*\)\s*$/u, '').trim();
}

function fileIdentity(info) {
  return { device: String(info.dev), inode: String(info.ino), createdNs: String(info.birthtimeNs ?? 0n) };
}

function sameFileIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode && left?.createdNs === right?.createdNs;
}

export class LibvirtPersistentEnvironment {
  #directory;
  #sourceRoot;
  #identity;
  #invoke;
  #stateFile;

  constructor({ directory, sourceRoot, identity, invoke }) {
    if (typeof identity !== 'string' || !TOKEN.test(identity)) throw new TypeError('environment identity is invalid');
    if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
    this.#directory = path.resolve(directory);
    this.#sourceRoot = path.resolve(sourceRoot);
    this.#identity = identity;
    this.#invoke = invoke;
    this.#stateFile = path.join(this.#directory, 'state.json');
  }

  async #ensure() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment storage root must be a real directory');
    const objects = path.join(this.#directory, 'objects');
    await mkdir(objects, { recursive: true, mode: 0o700 });
    const objectInfo = await lstat(objects);
    if (!objectInfo.isDirectory() || objectInfo.isSymbolicLink()) throw new Error('environment object root must be a real directory');
  }

  async #load() {
    await this.#ensure();
    try {
      const info = await lstat(this.#stateFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment adapter state must be a real file');
      const state = JSON.parse(await readFile(this.#stateFile, 'utf8'));
      if (!state || state.protocol !== PROTOCOL || !state.records) throw new Error('environment adapter state is invalid');
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

  async #run(executable, argumentsList, { input = null, timeoutMs = 60_000, maxOutputBytes = 1024 * 1024 } = {}) {
    return this.#invoke({ executable, arguments: argumentsList, input, timeoutMs, maxOutputBytes });
  }

  async #require(executable, argumentsList, options = {}) {
    const result = await this.#run(executable, argumentsList, options);
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
      const detail = result?.stderr?.trim() || result?.stdout?.trim() || 'environment management operation failed';
      throw new Error(detail.slice(0, 2048));
    }
    return result.stdout;
  }

  #descriptor(identity) {
    if (typeof identity !== 'string' || !ENVIRONMENT.test(identity)) throw new TypeError('environment identity is invalid');
    const local = path.join(this.#directory, 'objects', identity);
    return {
      name: ownedName(this.#identity, identity),
      uuid: deterministicUuid(this.#identity, identity),
      marker: marker(this.#identity, identity),
      local,
      diskPath: path.join(local, 'state.qcow2'),
    };
  }

  #record(state, identity) {
    const record = state.records[identity];
    if (!record) return null;
    const descriptor = this.#descriptor(identity);
    if (record.identity !== identity || !SAFE_ID.test(String(record.sourceIdentity ?? ''))) throw new Error('environment adapter record identity is invalid');
    if (path.resolve(record.diskPath) !== descriptor.diskPath || record.name !== descriptor.name || record.uuid !== descriptor.uuid || record.marker !== descriptor.marker) {
      throw new Error('environment adapter record escaped its local contract');
    }
    const parent = path.resolve(record.parentPath);
    const relative = path.relative(this.#sourceRoot, parent);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('environment adapter source record escaped the admitted root');
    return record;
  }

  async #source(source) {
    const value = requireObject(source, 'environment source');
    onlyKeys(value, new Set(['identity', 'revision', 'digest', 'handle']), 'environment source');
    if (typeof value.identity !== 'string' || !SAFE_ID.test(value.identity)) throw new TypeError('environment source identity is invalid');
    if (typeof value.revision !== 'string' || !SAFE_ID.test(value.revision)) throw new TypeError('environment source revision is invalid');
    const digest = String(value.digest ?? '').toLowerCase();
    if (!DIGEST.test(digest)) throw new TypeError('environment source digest is invalid');
    const handle = requireObject(value.handle, 'environment source handle');
    onlyKeys(handle, new Set(['location', 'format']), 'environment source handle');
    const location = handle.location;
    if (typeof location !== 'string' || location.length === 0 || location.includes('\0')) throw new TypeError('environment source location is invalid');
    const candidate = path.resolve(location);
    const info = await lstat(candidate, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment source must be a real regular file');
    const [root, actual] = await Promise.all([realpath(this.#sourceRoot), realpath(candidate)]);
    const relative = path.relative(root, actual);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('environment source is outside the admitted root');
    if (String(handle.format ?? '').toLowerCase() !== 'qcow2') throw new Error('environment source media is not supported by this adapter');
    return { identity: value.identity, revision: value.revision, digest, location: actual, fileIdentity: fileIdentity(info) };
  }

  async #overlayObservation(record) {
    let overlayInfo;
    let parentInfo;
    try {
      [overlayInfo, parentInfo] = await Promise.all([lstat(record.diskPath, { bigint: true }), lstat(record.parentPath, { bigint: true })]);
    } catch (error) {
      if (error?.code === 'ENOENT') return { compatible: false, reason: 'environment storage lineage is incomplete', storage: null };
      throw error;
    }
    if (!overlayInfo.isFile() || overlayInfo.isSymbolicLink() || !parentInfo.isFile() || parentInfo.isSymbolicLink()) {
      return { compatible: false, reason: 'environment storage lineage shape changed', storage: null };
    }
    if (!sameFileIdentity(record.parentFileIdentity, fileIdentity(parentInfo))) {
      return { compatible: false, reason: 'environment source filesystem identity changed', storage: null };
    }
    if (record.diskFileIdentity && !sameFileIdentity(record.diskFileIdentity, fileIdentity(overlayInfo))) {
      return { compatible: false, reason: 'environment writable filesystem identity changed', storage: null };
    }
    let parsed;
    try {
      const output = await this.#require('qemu-img', ['info', '-U', '--output=json', '--backing-chain', record.diskPath], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 });
      parsed = JSON.parse(output);
    } catch (error) {
      return { compatible: false, reason: `environment storage inspection failed: ${error.message}`, storage: null };
    }
    const chain = Array.isArray(parsed) ? parsed : [parsed];
    const head = chain[0];
    if (!head || chain.length !== 2 || String(head.format).toLowerCase() !== 'qcow2' || String(chain[1]?.format).toLowerCase() !== 'qcow2') {
      return { compatible: false, reason: 'environment storage backing depth or format changed', storage: null };
    }
    const backing = head['full-backing-filename'] ?? head['backing-filename'];
    if (typeof backing !== 'string') return { compatible: false, reason: 'environment storage backing identity is absent', storage: null };
    const actualParent = path.resolve(path.dirname(record.diskPath), backing);
    const [expectedParent, canonicalActual] = await Promise.all([realpath(record.parentPath), realpath(actualParent).catch(() => null)]);
    if (!canonicalActual || canonicalActual !== expectedParent) return { compatible: false, reason: 'environment storage backing identity changed', storage: null };
    const allocatedBytes = Number(overlayInfo.blocks) * 512;
    const storageIdentity = createHash('sha256').update(`${overlayInfo.dev}:${overlayInfo.ino}`).digest('hex').slice(0, 32);
    return {
      compatible: true,
      reason: null,
      storage: { identity: storageIdentity, sourceIdentity: record.sourceIdentity, allocatedBytes: Number.isSafeInteger(allocatedBytes) ? allocatedBytes : Number(overlayInfo.size) },
      fileIdentity: fileIdentity(overlayInfo),
    };
  }

  async #domainObservation(record) {
    const names = (await this.#require('virsh', ['-c', URI, 'list', '--all', '--name'])).split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
    if (!names.includes(record.name)) return { exists: false, owned: false, compatible: false, state: 'absent', reason: 'owned environment configuration is absent' };
    const uuid = (await this.#require('virsh', ['-c', URI, 'domuuid', record.name])).trim();
    const state = stateFromText(await this.#require('virsh', ['-c', URI, 'domstate', record.name, '--reason']));
    if (uuid !== record.uuid) return { exists: true, owned: false, compatible: false, state, reason: 'environment ownership identity does not match' };
    const xml = await this.#require('virsh', ['-c', URI, 'dumpxml', record.name], { maxOutputBytes: 2 * 1024 * 1024 });
    if (!xml.includes(record.marker)) return { exists: true, owned: false, compatible: false, state, reason: 'environment ownership marker does not match' };
    if (!new RegExp(`<source\\s+file=['"]${regexEscape(xmlEscape(record.diskPath))}['"]`, 'u').test(xml) && !xml.includes(`file='${xmlEscape(record.diskPath)}'`) && !xml.includes(`file=\"${xmlEscape(record.diskPath)}\"`)) {
      return { exists: true, owned: true, compatible: false, state, reason: 'environment storage attachment does not match' };
    }
    return { exists: true, owned: true, compatible: true, state, reason: null, xml };
  }

  async inspect() { return { identity: bindingIdentity(this.#identity) }; }

  async provision(raw) {
    const input = requireObject(raw, 'environment provision request');
    onlyKeys(input, new Set(['identity', 'source', 'settings']), 'environment provision request');
    const identity = input.identity;
    const descriptor = this.#descriptor(identity);
    const admitted = await this.#source(input.source);
    const settings = normalizeSettings(input.settings);
    const state = await this.#load();
    const record = {
      identity,
      sourceIdentity: admitted.identity,
      sourceRevision: admitted.revision,
      sourceDigest: admitted.digest,
      parentPath: admitted.location,
      parentFileIdentity: admitted.fileIdentity,
      diskPath: descriptor.diskPath,
      diskFileIdentity: null,
      name: descriptor.name,
      uuid: descriptor.uuid,
      marker: descriptor.marker,
      settings: structuredClone(settings),
    };
    const existing = this.#record(state, identity);
    if (existing) {
      const comparableExisting = { ...existing, diskFileIdentity: null };
      if (JSON.stringify(comparableExisting) !== JSON.stringify(record)) throw new Error('environment adapter record conflicts with the requested lineage');
    } else {
      state.records[identity] = record;
      await this.#save(state);
    }

    await mkdir(descriptor.local, { recursive: true, mode: 0o700 });
    const localInfo = await lstat(descriptor.local);
    if (!localInfo.isDirectory() || localInfo.isSymbolicLink()) throw new Error('environment object directory must be a real directory');
    try {
      const info = await lstat(descriptor.diskPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment writable state shape changed');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#require('qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', admitted.location, descriptor.diskPath], { timeoutMs: 60_000 });
    }
    const storage = await this.#overlayObservation(state.records[identity]);
    if (!storage.compatible) throw new Error(storage.reason);
    if (!state.records[identity].diskFileIdentity) {
      state.records[identity].diskFileIdentity = storage.fileIdentity;
      await this.#save(state);
    }

    const domain = await this.#domainObservation(state.records[identity]);
    if (domain.exists && (!domain.owned || !domain.compatible)) throw new Error(domain.reason ?? 'existing environment configuration is incompatible');
    if (!domain.exists) {
      const memoryKiB = Math.ceil(settings.memoryBytes / 1024);
      const osXml = settings.firmware === 'efi' ? "<os firmware='efi'><type>hvm</type></os>" : '<os><type>hvm</type></os>';
      const xml = `<domain type="kvm"><name>${xmlEscape(record.name)}</name><uuid>${record.uuid}</uuid><metadata><owner xmlns="urn:devbridge:ownership">${xmlEscape(record.marker)}</owner></metadata><memory unit="KiB">${memoryKiB}</memory><currentMemory unit="KiB">${memoryKiB}</currentMemory><vcpu placement="static">${settings.processorCount}</vcpu>${osXml}<features><acpi/><apic/></features><devices><disk type="file" device="disk"><driver name="qemu" type="qcow2"/><source file="${xmlEscape(record.diskPath)}"/><backingStore type="file"><format type="qcow2"/><source file="${xmlEscape(record.parentPath)}"/><backingStore/></backingStore><target dev="vda" bus="virtio"/></disk></devices></domain>`;
      const definition = path.join(descriptor.local, 'definition.xml');
      await writeFile(definition, xml, { encoding: 'utf8', mode: 0o600 });
      try { await this.#require('virsh', ['-c', URI, 'define', definition], { timeoutMs: 30_000 }); }
      finally { await rm(definition, { force: true }); }
    }
    return this.observe(identity);
  }

  async observe(identity) {
    this.#descriptor(identity);
    const state = await this.#load();
    const record = this.#record(state, identity);
    if (!record) return { identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'environment adapter record is absent', storage: null };
    const domain = await this.#domainObservation(record);
    const storage = await this.#overlayObservation(record);
    return {
      identity,
      exists: domain.exists,
      owned: domain.owned,
      compatible: domain.compatible && storage.compatible,
      state: domain.state,
      reason: domain.reason ?? storage.reason,
      storage: storage.storage,
    };
  }

  async start(identity) {
    const state = await this.#load();
    const record = this.#record(state, identity);
    if (!record) throw new Error('environment adapter record is absent');
    const observed = await this.observe(identity);
    if (!observed.exists || !observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment is unavailable');
    if (!['running', 'blocked'].includes(observed.state)) await this.#require('virsh', ['-c', URI, 'start', record.name], { timeoutMs: 60_000 });
    return this.observe(identity);
  }

  async stop(identity, { force = false, timeoutMs = 60_000 } = {}) {
    if (typeof force !== 'boolean') throw new TypeError('environment stop force must be boolean');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new TypeError('environment stop timeoutMs is invalid');
    const state = await this.#load();
    const record = this.#record(state, identity);
    if (!record) return { identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'environment adapter record is absent', storage: null };
    let observed = await this.observe(identity);
    if (!observed.exists) return observed;
    if (!observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment ownership evidence does not match');
    if (!['shut off', 'shutdown', 'crashed'].includes(observed.state)) {
      await this.#require('virsh', ['-c', URI, 'shutdown', record.name], { timeoutMs: 20_000 });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        observed = await this.observe(identity);
        if (!observed.exists || ['shut off', 'shutdown', 'crashed'].includes(observed.state)) break;
      }
      if (observed.exists && !['shut off', 'shutdown', 'crashed'].includes(observed.state)) {
        if (!force) throw new Error('environment did not stop within the bounded wait');
        await this.#require('virsh', ['-c', URI, 'destroy', record.name], { timeoutMs: 20_000 });
      }
    }
    return this.observe(identity);
  }

  async drop(identity) {
    const descriptor = this.#descriptor(identity);
    const state = await this.#load();
    const record = this.#record(state, identity);
    if (!record) return { identity, removed: false, absent: true };
    const observed = await this.observe(identity);
    if (observed.exists && (!observed.owned || !observed.compatible)) throw new Error(observed.reason ?? 'environment ownership evidence does not match');
    if (observed.exists && !['shut off', 'shutdown', 'crashed'].includes(observed.state)) throw new Error('environment must be stopped before removal');
    if (observed.exists) {
      const xml = await this.#require('virsh', ['-c', URI, 'dumpxml', record.name], { maxOutputBytes: 2 * 1024 * 1024 });
      const args = xml.includes('<nvram') ? ['-c', URI, 'undefine', record.name, '--nvram'] : ['-c', URI, 'undefine', record.name];
      await this.#require('virsh', args, { timeoutMs: 30_000 });
    }
    let diskExists = true;
    try { await lstat(record.diskPath); } catch (error) { if (error?.code === 'ENOENT') diskExists = false; else throw error; }
    if (diskExists) {
      const storage = await this.#overlayObservation(record);
      if (!storage.compatible) throw new Error(storage.reason ?? 'refusing to delete environment storage with mismatched lineage');
    }
    const localInfo = await lstat(descriptor.local).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (localInfo && (!localInfo.isDirectory() || localInfo.isSymbolicLink())) throw new Error('environment object directory shape changed');
    await rm(descriptor.local, { recursive: true, force: true });
    delete state.records[identity];
    await this.#save(state);
    return { identity, removed: true, absent: !observed.exists };
  }
}
