const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const IDENTITY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const URI = 'qemu:///system';
const MAX_RESPONSE_BYTES = 7 * 1024 * 1024;
const MAX_FRAME_BYTES = 44 * 1024;
const MAX_QGA_ARGUMENT_BYTES = 64 * 1024;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function bounded(value, name, maxBytes = 8_192) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeTarget(value) {
  if (typeof value !== 'string' || !TARGET.test(value)) throw new TypeError('bridge target is invalid');
  return value;
}

function normalizeLocation(raw) {
  const value = requireObject(raw, 'bridge location');
  onlyKeys(value, new Set(['reference', 'identity', 'proof']), 'bridge location');
  if (typeof value.reference !== 'string' || !REFERENCE.test(value.reference)) throw new TypeError('bridge location.reference is invalid');
  if (typeof value.identity !== 'string' || !IDENTITY.test(value.identity)) throw new TypeError('bridge location.identity is invalid');
  return {
    reference: value.reference,
    identity: value.identity.toLowerCase(),
    proof: bounded(value.proof, 'bridge location.proof', 2_048),
  };
}

function normalizeAccess(raw) {
  const value = requireObject(raw, 'bridge access');
  onlyKeys(value, new Set(['family']), 'bridge access');
  if (!['linux', 'windows'].includes(value.family)) throw new TypeError('bridge access.family is invalid');
  return { family: value.family };
}

function parseInvocation(result, name, maxBytes = MAX_RESPONSE_BYTES) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    const detail = String(result?.stderr || result?.stdout || `${name} failed`).trim().slice(0, 2_048);
    throw new Error(detail || `${name} failed`);
  }
  const text = String(result.stdout ?? '').trim();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${name} returned oversized output`);
  return text;
}

function parseJson(text, name) {
  try { return JSON.parse(text); } catch { throw new Error(`${name} returned invalid structured output`); }
}

function canonicalBase64(value, name, maxBytes = MAX_RESPONSE_BYTES) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > Math.ceil(maxBytes * 4 / 3) + 16) throw new Error(`${name} is invalid`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw new Error(`${name} is not canonical bounded base64`);
  return bytes;
}

export class LibvirtEnvironmentBridge {
  #invoke;
  #access;
  #locate;

  constructor({ invoke, access, locate }) {
    if (typeof invoke !== 'function') throw new TypeError('bridge invoke must be a function');
    if (typeof access !== 'function') throw new TypeError('bridge access must be a function');
    if (typeof locate !== 'function') throw new TypeError('bridge locate must be a function');
    this.#invoke = invoke;
    this.#access = access;
    this.#locate = locate;
  }

  async #virsh(argumentsList, { signal = null, timeoutMs = 45_000, maxOutputBytes = MAX_RESPONSE_BYTES } = {}) {
    return parseInvocation(await this.#invoke({
      executable: 'virsh',
      arguments: ['-c', URI, ...argumentsList],
      input: null,
      timeoutMs,
      maxOutputBytes,
      signal,
    }), 'bridge management operation', maxOutputBytes);
  }

  async #verify(target, { signal = null } = {}) {
    const location = normalizeLocation(await this.#locate(target));
    const observedIdentity = (await this.#virsh(['domuuid', location.reference], { signal, maxOutputBytes: 4_096 })).trim().toLowerCase();
    if (observedIdentity !== location.identity) throw new Error('environment ownership identity does not match');
    const xml = await this.#virsh(['dumpxml', location.reference], { signal, maxOutputBytes: 2 * 1024 * 1024 });
    if (!xml.includes(location.proof)) throw new Error('environment ownership proof does not match');
    if (!xml.includes('org.qemu.guest_agent.0')) throw new Error('environment guest-agent channel is unavailable');
    const state = (await this.#virsh(['domstate', location.reference], { signal, maxOutputBytes: 4_096 })).trim().toLowerCase().replace(/\s+\([^)]*\)\s*$/u, '');
    if (!['running', 'blocked'].includes(state)) throw new Error('environment is not running');
    return location;
  }

  async #agent(reference, command, { signal = null } = {}) {
    const encoded = JSON.stringify(command);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_QGA_ARGUMENT_BYTES) throw new Error('bridge agent request exceeds the local management argument limit');
    const text = await this.#virsh(['qemu-agent-command', reference, '--timeout', '30', encoded], { signal, timeoutMs: 45_000 });
    return parseJson(text, 'bridge agent operation');
  }

  async exchange(frame, { signal = null } = {}) {
    const target = normalizeTarget(frame?.target);
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FRAME_BYTES) throw new Error('bridge frame exceeds this attachment limit');
    const selected = normalizeAccess(await this.#access(target));
    const location = await this.#verify(target, { signal });
    const program = selected.family === 'windows' ? 'node.exe' : 'node';
    const helper = selected.family === 'windows' ? 'C:\\ProgramData\\DevBridge\\bridge-agent.mjs' : '/usr/local/libexec/devbridge/bridge-agent.mjs';
    const start = await this.#agent(location.reference, {
      execute: 'guest-exec',
      arguments: {
        path: program,
        arg: [helper, '--exchange-stdin'],
        env: [`DEVBRIDGE_GUEST_TARGET=${target}`],
        'input-data': Buffer.from(serialized, 'utf8').toString('base64'),
        'capture-output': true,
      },
    }, { signal });
    const pid = Number(start?.return?.pid);
    if (!Number.isSafeInteger(pid) || pid < 0) throw new Error('bridge agent did not return a valid process identity');

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = await this.#agent(location.reference, { execute: 'guest-exec-status', arguments: { pid } }, { signal });
      const value = requireObject(status?.return, 'bridge agent status');
      if (value.exited !== true) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      if (value['out-truncated'] === true || value['err-truncated'] === true) throw new Error('bridge agent output was truncated');
      if (value.signal != null) throw new Error('bridge helper terminated by signal');
      if (!Number.isInteger(value.exitcode) || value.exitcode !== 0) throw new Error('bridge helper exited unsuccessfully');
      const stderr = value['err-data'] == null ? Buffer.alloc(0) : canonicalBase64(value['err-data'], 'bridge agent stderr', 64 * 1024);
      if (stderr.length > 0) throw new Error(`bridge helper wrote unexpected stderr: ${stderr.toString('utf8').slice(0, 2_048)}`);
      const stdout = canonicalBase64(value['out-data'] ?? '', 'bridge agent stdout');
      const text = stdout.toString('utf8').trim();
      if (!text) throw new Error('bridge helper returned empty output');
      return parseJson(text, 'bridge helper');
    }
    throw new Error('bridge helper status did not complete within the bounded wait');
  }
}
