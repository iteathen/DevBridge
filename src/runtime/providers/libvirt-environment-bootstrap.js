import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const IDENTITY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const URI = 'qemu:///system';

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

function normalizeLocation(raw) {
  const value = requireObject(raw, 'bootstrap location');
  onlyKeys(value, new Set(['reference', 'identity', 'proof', 'family', 'network']), 'bootstrap location');
  if (typeof value.reference !== 'string' || !REFERENCE.test(value.reference)) throw new TypeError('bootstrap location.reference is invalid');
  if (typeof value.identity !== 'string' || !IDENTITY.test(value.identity)) throw new TypeError('bootstrap location.identity is invalid');
  if (!['windows', 'linux'].includes(value.family)) throw new TypeError('bootstrap location.family is invalid');
  const network = requireObject(value.network, 'bootstrap location.network');
  onlyKeys(network, new Set(['reference', 'proof']), 'bootstrap location.network');
  if (typeof network.reference !== 'string' || !REFERENCE.test(network.reference)) throw new TypeError('bootstrap network.reference is invalid');
  return {
    reference: value.reference,
    identity: value.identity.toLowerCase(),
    proof: bounded(value.proof, 'bootstrap location.proof', 2_048),
    family: value.family,
    network: {
      reference: network.reference,
      proof: bounded(network.proof, 'bootstrap location.network.proof', 2_048),
    },
  };
}

function normalizeConnection(raw, family) {
  const value = requireObject(raw, 'bootstrap connection');
  onlyKeys(value, new Set(['family']), 'bootstrap connection');
  if (value.family !== family) throw new TypeError('bootstrap connection family changed');
  return { family };
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function stateText(text) {
  return String(text).trim().toLowerCase().replace(/\s+\([^)]*\)\s*$/u, '');
}

export class LibvirtEnvironmentBootstrap {
  #directory;
  #invoke;
  #locate;
  #connection;

  constructor({ directory, invoke, locate, connection }) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('bootstrap directory is required');
    if (typeof invoke !== 'function') throw new TypeError('bootstrap invoke must be a function');
    if (typeof locate !== 'function') throw new TypeError('bootstrap locate must be a function');
    if (typeof connection !== 'function') throw new TypeError('bootstrap connection must be a function');
    this.#directory = path.resolve(directory);
    this.#invoke = invoke;
    this.#locate = locate;
    this.#connection = connection;
  }

  async #ensure() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('bootstrap directory must be a real directory');
  }

  async #virsh(args, { timeoutMs = 45_000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
    const result = await this.#invoke({
      executable: 'virsh',
      arguments: ['-c', URI, ...args],
      input: null,
      timeoutMs,
      maxOutputBytes,
    });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
      throw new Error(String(result?.stderr || result?.stdout || 'bootstrap management operation failed').trim().slice(0, 2_048));
    }
    return String(result.stdout ?? '');
  }

  async #resolved(target) {
    const location = normalizeLocation(await this.#locate(target));
    const connection = normalizeConnection(await this.#connection(target), location.family);
    return { location, connection };
  }

  async #verify(location) {
    const identity = (await this.#virsh(['domuuid', location.reference], { maxOutputBytes: 4_096 })).trim().toLowerCase();
    if (identity !== location.identity) throw new Error('environment ownership identity does not match');
    const xml = await this.#virsh(['dumpxml', location.reference]);
    if (!xml.includes(location.proof)) throw new Error('environment ownership proof does not match');
    const networkXml = await this.#virsh(['net-dumpxml', location.network.reference]);
    if (!networkXml.includes(location.network.proof)) throw new Error('network ownership proof does not match');
    return { xml, state: stateText(await this.#virsh(['domstate', location.reference, '--reason'], { maxOutputBytes: 4_096 })) };
  }

  async prepare(rawTarget) {
    const target = targetId(rawTarget);
    const { location } = await this.#resolved(target);
    let observed = await this.#verify(location);
    const networkPattern = new RegExp(`<source\\s+[^>]*network=['"]${regexEscape(location.network.reference)}['"]`, 'u');
    const hasNetwork = networkPattern.test(observed.xml);
    const hasAgent = /<target\s+[^>]*type=['"]virtio['"][^>]*name=['"]org\.qemu\.guest_agent\.0['"]/u.test(observed.xml);
    if (hasNetwork && hasAgent) return { ready: true, cycleRequired: false };
    if (!['shut off', 'shutdown', 'crashed'].includes(observed.state)) return { ready: false, cycleRequired: true };

    if (!hasNetwork) {
      await this.#virsh(['attach-interface', '--domain', location.reference, '--type', 'network', '--source', location.network.reference, '--model', 'virtio', '--config'], { timeoutMs: 30_000 });
    }
    if (!hasAgent) {
      await this.#ensure();
      const file = path.join(this.#directory, `channel-${randomUUID()}.xml`);
      const xml = `<channel type="unix"><target type="virtio" name="org.qemu.guest_agent.0"/></channel>`;
      await writeFile(file, xml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      try { await this.#virsh(['attach-device', location.reference, file, '--config'], { timeoutMs: 30_000 }); }
      finally { await rm(file, { force: true }); }
    }
    observed = await this.#verify(location);
    if (!networkPattern.test(observed.xml) || !/<target\s+[^>]*type=['"]virtio['"][^>]*name=['"]org\.qemu\.guest_agent\.0['"]/u.test(observed.xml)) {
      throw new Error('bootstrap device preparation did not reconcile');
    }
    return { ready: true, cycleRequired: false };
  }

  async activate(rawTarget) {
    const target = targetId(rawTarget);
    const { location } = await this.#resolved(target);
    const observed = await this.#verify(location);
    if (!['running', 'blocked'].includes(observed.state)) throw new Error('environment is not running');
    const deadline = Date.now() + 60_000;
    let last = null;
    do {
      try {
        const text = await this.#virsh(['qemu-agent-command', location.reference, '--timeout', '5', '{"execute":"guest-ping"}'], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
        const value = JSON.parse(text);
        if (value && Object.prototype.hasOwnProperty.call(value, 'return')) return { ready: true };
        last = new Error('guest agent ping did not return a structured result');
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < deadline);
    throw new Error(`guest agent did not become ready: ${last?.message ?? 'unknown failure'}`);
  }

  async connection(rawTarget) {
    const target = targetId(rawTarget);
    const { connection } = await this.#resolved(target);
    return { ...connection };
  }

  async reconcile(activeTargets = []) {
    if (!Array.isArray(activeTargets) || activeTargets.some((entry) => typeof entry !== 'string' || !TARGET.test(entry))) throw new TypeError('bootstrap active targets are invalid');
    return { changed: false, retained: activeTargets.length };
  }
}
