import { lstat, realpath } from 'node:fs/promises';

const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/u;
const SENTINEL = 'devbridge-image-sanitize-v1';
const REMOTE = '/usr/local/libexec/devbridge/image-sanitize.sh';

function executable(platform) { return platform === 'win32' ? 'ssh.exe' : 'ssh'; }

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

async function regular(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is invalid`);
  const info = await lstat(value);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a real regular file`);
  return realpath(value);
}

async function normalizeAccess(raw) {
  const value = onlyKeys(raw, new Set(['family', 'user', 'address', 'identityFile', 'knownHostsFile']), 'image finalization access');
  if (value.family !== 'linux') throw new TypeError('image finalization access family is invalid');
  if (typeof value.user !== 'string' || !USER.test(value.user)) throw new TypeError('image finalization access user is invalid');
  if (typeof value.address !== 'string' || !ADDRESS.test(value.address)) throw new TypeError('image finalization access address is invalid');
  const [identityFile, knownHostsFile] = await Promise.all([
    regular(value.identityFile, 'image finalization identity file'),
    regular(value.knownHostsFile, 'image finalization known-hosts file'),
  ]);
  return { family: 'linux', user: value.user, address: value.address, identityFile, knownHostsFile };
}

export class SshImageFinalization {
  #invoke;
  #access;
  #executable;

  constructor({ invoke, access, executable: selected = executable(process.platform) } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('image finalization invocation contract is invalid');
    if (typeof access !== 'function') throw new TypeError('image finalization access contract is invalid');
    if (typeof selected !== 'string' || selected.length === 0 || selected.includes('\0')) throw new TypeError('image finalization executable is invalid');
    this.#invoke = invoke;
    this.#access = access;
    this.#executable = selected;
  }

  async finalize(rawTarget) {
    if (typeof rawTarget !== 'string' || !TARGET.test(rawTarget)) throw new TypeError('image finalization target is invalid');
    const selected = await normalizeAccess(await this.#access(rawTarget));
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const result = await this.#invoke({
      executable: this.#executable,
      arguments: [
        '-F', nullDevice, '-T',
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${selected.knownHostsFile}`, '-o', `GlobalKnownHostsFile=${nullDevice}`,
        '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no',
        '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
        '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
        '-o', 'ConnectTimeout=8', '-i', selected.identityFile,
        `${selected.user}@${selected.address}`, 'sudo', REMOTE,
      ],
      input: null,
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
    });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
      throw new Error(String(result?.stderr || result?.stdout || 'image finalization failed').trim().slice(0, 2048));
    }
    if (String(result.stdout ?? '').trim() !== SENTINEL) throw new Error('image finalization did not return the expected completion evidence');
    return Object.freeze({ finalized: true, protocol: 'devbridge/image-finalization-v1' });
  }
}

export function createSshImageFinalization(options) {
  return new SshImageFinalization(options);
}
