import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const TOKEN = /^[a-f0-9]{32}$/u;
const ENVIRONMENT = /^env-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
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

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function fileIdentity(info) {
  return { device: String(info.dev), inode: String(info.ino), createdNs: String(info.birthtimeNs ?? 0n) };
}

export class LibvirtEnvironmentContract {
  #directory;
  #sourceRoot;
  #identity;
  #normalizeProtection;

  constructor({ directory, sourceRoot, identity, normalizeProtection }) {
    if (typeof identity !== 'string' || !TOKEN.test(identity)) throw new TypeError('environment identity is invalid');
    if (typeof normalizeProtection !== 'function') throw new TypeError('environment protection normalizer is required');
    this.#directory = path.resolve(directory);
    this.#sourceRoot = path.resolve(sourceRoot);
    this.#identity = identity;
    this.#normalizeProtection = normalizeProtection;
  }

  binding() {
    return createHash('sha256').update(`${this.#identity}:persistent-environment:libvirt:v1`).digest('hex').slice(0, 32);
  }

  descriptor(identity) {
    if (typeof identity !== 'string' || !ENVIRONMENT.test(identity)) throw new TypeError('environment identity is invalid');
    const local = path.join(this.#directory, 'objects', identity);
    const seed = createHash('sha256').update(`${this.#identity}:persistent:${identity}`).digest('hex');
    const uuidHex = seed.slice(0, 32).split('');
    uuidHex[12] = '4';
    uuidHex[16] = ((Number.parseInt(uuidHex[16], 16) & 0x3) | 0x8).toString(16);
    const joined = uuidHex.join('');
    return {
      name: `db-env-${seed.slice(0, 16)}`,
      uuid: `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`,
      marker: `devbridge-owned:${this.#identity}:persistent:${identity}:v1`,
      local,
      diskPath: path.join(local, 'state.qcow2'),
    };
  }

  request(raw) {
    const input = requireObject(raw, 'environment provision request');
    onlyKeys(input, new Set(['identity', 'source', 'settings']), 'environment provision request');
    return input;
  }

  settings(raw) {
    const value = requireObject(raw, 'environment settings');
    onlyKeys(value, new Set(['memoryBytes', 'processorCount', 'firmware', 'bootProtection']), 'environment settings');
    if (!Number.isSafeInteger(value.memoryBytes) || value.memoryBytes < MIN_MEMORY_BYTES || value.memoryBytes > MAX_MEMORY_BYTES) throw new TypeError('environment settings.memoryBytes is invalid');
    if (!Number.isSafeInteger(value.processorCount) || value.processorCount < 1 || value.processorCount > MAX_PROCESSORS) throw new TypeError('environment settings.processorCount is invalid');
    if (!['efi', 'bios'].includes(value.firmware)) throw new TypeError('environment settings.firmware is invalid');
    if (this.#normalizeProtection(value.bootProtection, { optional: true, name: 'environment settings.bootProtection' })) {
      throw new Error('protected boot is unavailable through this environment adapter');
    }
    return { memoryBytes: value.memoryBytes, processorCount: value.processorCount, firmware: value.firmware };
  }

  record(state, identity) {
    const record = state.records[identity];
    if (!record) return null;
    const descriptor = this.descriptor(identity);
    if (record.identity !== identity || !SAFE_ID.test(String(record.sourceIdentity ?? ''))) throw new Error('environment adapter record identity is invalid');
    if (path.resolve(record.diskPath) !== descriptor.diskPath || record.name !== descriptor.name || record.uuid !== descriptor.uuid || record.marker !== descriptor.marker) {
      throw new Error('environment adapter record escaped its local contract');
    }
    const parent = path.resolve(record.parentPath);
    const relative = path.relative(this.#sourceRoot, parent);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('environment adapter source record escaped the admitted root');
    return record;
  }

  async source(raw) {
    const value = requireObject(raw, 'environment source');
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

  definition(record, settings) {
    const memoryKiB = Math.ceil(settings.memoryBytes / 1024);
    const osXml = settings.firmware === 'efi' ? "<os firmware='efi'><type>hvm</type></os>" : '<os><type>hvm</type></os>';
    return `<domain type="kvm"><name>${xmlEscape(record.name)}</name><uuid>${record.uuid}</uuid><metadata><owner xmlns="urn:devbridge:ownership">${xmlEscape(record.marker)}</owner></metadata><memory unit="KiB">${memoryKiB}</memory><currentMemory unit="KiB">${memoryKiB}</currentMemory><vcpu placement="static">${settings.processorCount}</vcpu>${osXml}<features><acpi/><apic/></features><devices><disk type="file" device="disk"><driver name="qemu" type="qcow2"/><source file="${xmlEscape(record.diskPath)}"/><backingStore type="file"><format type="qcow2"/><source file="${xmlEscape(record.parentPath)}"/><backingStore/></backingStore><target dev="vda" bus="virtio"/></disk></devices></domain>`;
  }
}
