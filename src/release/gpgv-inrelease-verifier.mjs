import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  sameFilesystemIdentity,
  sameObservedFilesystemIdentity,
} from '../runtime/local-filesystem-identity.js';

const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/u;
const MAX_KEYRING_BYTES = 16 * 1024 * 1024;
const MAX_INRELEASE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SAFE_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function sameFile(left, right) {
  return sameObservedFilesystemIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function directFile(location, name, maximum) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || location.includes('\0')) {
    throw new TypeError(`${name} path is invalid`);
  }
  const selected = path.resolve(location);
  if (!await sameFilesystemIdentity(selected, await realpath(selected))) fail(`${name} must use a direct nonsymbolic path`);
  const info = await lstat(selected, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 1n || info.size > BigInt(maximum)) {
    fail(`${name} must be one bounded unlinked regular file`);
  }
  return Object.freeze({ location: selected, info });
}

function runGpgv(executable, keyring, bytes, signal) {
  return new Promise((resolve, reject) => {
    const environment = { LANG: 'C', LC_ALL: 'C' };
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
      if (typeof process.env[name] === 'string') environment[name] = process.env[name];
    }
    const child = spawn(executable, ['--status-fd', '1', '--keyring', keyring, '-'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
      signal: signal ?? undefined,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const collect = (target, field) => (chunk) => {
      if (field === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout, 'stdout'));
    child.stderr.on('data', collect(stderr, 'stderr'));
    child.once('error', reject);
    child.once('close', (code, childSignal) => {
      if (overflow) { reject(new Error('gpgv output exceeded its bound')); return; }
      resolve(Object.freeze({
        code,
        signal: childSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    });
    child.stdin.once('error', (error) => {
      if (error?.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(bytes);
  });
}

export class GpgvInReleaseVerifier {
  constructor(raw = {}) {
    const { executable, keyring, run = runGpgv } = exactObject(raw, new Set(['executable', 'keyring', 'run']), 'gpgv verifier options');
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')) {
      throw new TypeError('gpgv executable path is invalid');
    }
    if (typeof keyring !== 'string' || !path.isAbsolute(keyring) || keyring.includes('\0')) {
      throw new TypeError('gpgv keyring path is invalid');
    }
    if (typeof run !== 'function') throw new TypeError('gpgv runner port is invalid');
    this.executable = path.resolve(executable);
    this.keyring = path.resolve(keyring);
    this.run = run;
  }

  async verify(raw = {}) {
    const { bytes, expectedFingerprint, context = null, signal = null } = exactObject(
      raw,
      new Set(['bytes', 'expectedFingerprint', 'context', 'signal']),
      'InRelease verification request',
    );
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_INRELEASE_BYTES) {
      throw new TypeError('InRelease bytes are invalid');
    }
    if (typeof expectedFingerprint !== 'string' || !FINGERPRINT.test(expectedFingerprint)) {
      throw new TypeError('InRelease expected fingerprint is invalid');
    }
    if (context != null && (typeof context !== 'string' || !SAFE_CONTEXT.test(context))) {
      throw new TypeError('InRelease verification context is invalid');
    }
    if (signal != null && typeof signal !== 'object') throw new TypeError('InRelease signal is invalid');
    if (signal?.aborted) throw signal.reason ?? new Error('InRelease verification was interrupted');
    const [executable, keyring] = await Promise.all([
      directFile(this.executable, 'gpgv executable', 128 * 1024 * 1024),
      directFile(this.keyring, 'gpgv keyring', MAX_KEYRING_BYTES),
    ]);
    const observed = await this.run(executable.location, keyring.location, Buffer.from(bytes), signal);
    if (!observed || observed.code !== 0 || observed.signal != null
        || typeof observed.stdout !== 'string' || typeof observed.stderr !== 'string') {
      fail('InRelease signature verification failed');
    }
    const fingerprints = observed.stdout.replaceAll('\r\n', '\n').split('\n').flatMap((line) => {
      const match = /^\[GNUPG:\] VALIDSIG ([A-F0-9]{40}|[A-F0-9]{64})(?: |$)/u.exec(line);
      return match ? [match[1]] : [];
    });
    if (fingerprints.length !== 1 || fingerprints[0] !== expectedFingerprint) {
      fail('InRelease valid signature does not match the expected fingerprint');
    }
    const [afterExecutable, afterKeyring] = await Promise.all([
      lstat(executable.location, { bigint: true }),
      lstat(keyring.location, { bigint: true }),
    ]);
    if (!sameFile(executable.info, afterExecutable) || !sameFile(keyring.info, afterKeyring)) {
      fail('gpgv executable or keyring changed during verification');
    }
    return Object.freeze({ verified: true, fingerprint: fingerprints[0] });
  }
}
