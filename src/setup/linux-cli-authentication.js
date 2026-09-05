import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { invokeCommand } from '../runtime/command-invocation.js';

const OBSERVATION_PROTOCOL = 'devbridge/local-authentication-observation-v1';
const ATTEMPT_PROTOCOL = 'devbridge/local-authentication-attempt-v1';
const PROGRAM = '/usr/bin/sudo';
const ENTRY = fileURLToPath(new URL('./linux-cli-authenticated-entry.js', import.meta.url));
const PROGRAM_PARENTS = Object.freeze(['/', '/usr', '/usr/bin']);
const DIGEST = /^[0-9a-f]{64}$/u;
const TERMINAL = /^[A-Za-z0-9+._-]{1,128}$/u;
const MAX_SUBJECT_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 512n * 1024n * 1024n;
const SAFE_ENVIRONMENT = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' });

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${name} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key) || descriptors[key].enumerable !== true || !Object.hasOwn(descriptors[key], 'value')) {
      throw new TypeError(`${name} contains an unknown field`);
    }
  }
  return value;
}

function digest(parts) {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function fileIdentity(value) {
  return digest([
    String(value.dev), String(value.ino), String(value.mode), String(value.uid), String(value.gid),
    String(value.size), String(value.mtimeNs), String(value.ctimeNs),
  ]);
}

async function inspectRealFile(identity, { requireExecute, requireRoot, requireSetId }) {
  let handle = null;
  let releaseFailed = false;
  try {
    const before = await lstat(identity, { bigint: true });
    const canonical = await realpath(identity);
    handle = await open(identity, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const held = await handle.stat({ bigint: true });
    const after = await lstat(identity, { bigint: true });
    const mode = after.mode & 0o7777n;
    if (canonical !== identity || before.isSymbolicLink() || !before.isFile() || !held.isFile()
        || after.isSymbolicLink() || !after.isFile() || !sameFile(before, held) || !sameFile(held, after)
        || after.size < 1n || after.size > MAX_FILE_BYTES || after.nlink !== 1n
        || (mode & 0o022n) !== 0n || (requireExecute && (mode & 0o111n) === 0n)
        || (requireRoot && (after.uid !== 0n || after.gid !== 0n))
        || (requireSetId && (mode & 0o4000n) === 0n)) {
      throw new Error('local program identity is untrusted');
    }
    return fileIdentity(after);
  } finally {
    if (handle != null) {
      try { await handle.close(); }
      catch { releaseFailed = true; }
    }
    if (releaseFailed) throw new Error('local program identity release failed');
  }
}

async function inspectFixedProgram() {
  for (const parent of PROGRAM_PARENTS) {
    const info = await lstat(parent, { bigint: true });
    const canonical = await realpath(parent);
    if (canonical !== parent || info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0n || info.gid !== 0n
        || (info.mode & 0o022n) !== 0n) {
      throw new Error('local authentication parent identity is untrusted');
    }
  }
  return Object.freeze({
    identity: await inspectRealFile(PROGRAM, { requireExecute: true, requireRoot: true, requireSetId: true }),
  });
}

async function inspectFixedLaunch() {
  const identities = await Promise.all([
    inspectRealFile(process.execPath, { requireExecute: true, requireRoot: false, requireSetId: false }),
    inspectRealFile(ENTRY, { requireExecute: false, requireRoot: false, requireSetId: false }),
  ]);
  return Object.freeze({ identity: digest(identities) });
}

function observation({ platform, applicable, ready, identity, reason }) {
  return Object.freeze({ protocol: OBSERVATION_PROTOCOL, platform, applicable, ready, identity, reason });
}

function exactObservation(value) {
  exactKeys(value, new Set(['protocol', 'platform', 'applicable', 'ready', 'identity', 'reason']), 'local authentication observation');
  if (value.protocol !== OBSERVATION_PROTOCOL || typeof value.platform !== 'string' || value.platform.length < 1
      || value.platform.length > 32 || typeof value.applicable !== 'boolean' || typeof value.ready !== 'boolean') {
    throw new TypeError('local authentication observation is invalid');
  }
  if (value.ready) {
    if (value.applicable !== true || typeof value.identity !== 'string' || !DIGEST.test(value.identity) || value.reason !== null) {
      throw new TypeError('ready local authentication observation is invalid');
    }
  } else if (value.identity !== null || typeof value.reason !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.reason)) {
    throw new TypeError('unavailable local authentication observation is invalid');
  }
  return value;
}

export async function observeLinuxCliAuthentication(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(), 'local authentication observation request');
  exactKeys(providedPorts, new Set(['readPlatform', 'inspect']), 'local authentication observation ports');
  const readPlatform = providedPorts.readPlatform ?? (() => process.platform);
  const inspect = providedPorts.inspect ?? inspectFixedProgram;
  if (typeof readPlatform !== 'function' || typeof inspect !== 'function') throw new TypeError('local authentication observation ports are invalid');
  let platform;
  try { platform = await readPlatform(); }
  catch { return observation({ platform: 'unknown', applicable: false, ready: false, identity: null, reason: 'platform-unavailable' }); }
  if (platform !== 'linux') return observation({ platform: 'other', applicable: false, ready: false, identity: null, reason: 'not-applicable' });
  try {
    const inspected = exactKeys(await inspect(), new Set(['identity']), 'local authentication program identity');
    if (typeof inspected.identity !== 'string' || !DIGEST.test(inspected.identity)) throw new Error('local authentication program identity is invalid');
    return observation({ platform: 'linux', applicable: true, ready: true, identity: inspected.identity, reason: null });
  } catch {
    return observation({ platform: 'linux', applicable: true, ready: false, identity: null, reason: 'program-unavailable' });
  }
}

function attemptResult({ attempted, completed, reason }) {
  return Object.freeze({ protocol: ATTEMPT_PROTOCOL, attempted, completed, reason });
}

function unavailable(reason, { attempted = false } = {}) {
  return attemptResult({ attempted, completed: false, reason });
}

function frozenJson(value, state = { seen: new Set(), entries: 0 }, depth = 0) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('local authentication subject number is invalid');
    return;
  }
  if (typeof value === 'string') {
    if (value.includes('\0') || new TextEncoder().encode(value).byteLength > 8 * 1024) throw new TypeError('local authentication subject text is invalid');
    return;
  }
  if (!value || typeof value !== 'object' || depth > 16 || state.seen.has(value) || !Object.isFrozen(value)) {
    throw new TypeError('local authentication subject is invalid');
  }
  state.seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError('local authentication subject is invalid');
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError('local authentication subject is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value);
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))
        || names.length !== keys.length + 1 || names.at(-1) !== 'length') {
      throw new TypeError('local authentication subject is invalid');
    }
  } else if (Object.getOwnPropertyNames(value).length !== keys.length) {
    throw new TypeError('local authentication subject is invalid');
  }
  for (const key of keys) {
    if (key.includes('\0') || new TextEncoder().encode(key).byteLength > 1_024) {
      throw new TypeError('local authentication subject key is invalid');
    }
    if (descriptors[key].enumerable !== true || !Object.hasOwn(descriptors[key], 'value')) {
      throw new TypeError('local authentication subject is invalid');
    }
  }
  const entries = keys.map((key) => descriptors[key].value);
  state.entries += entries.length;
  if (state.entries > 1_024) throw new TypeError('local authentication subject is too large');
  for (const entry of entries) frozenJson(entry, state, depth + 1);
}

function minimalEnvironment(value) {
  const environment = { ...SAFE_ENVIRONMENT };
  if (typeof value === 'string' && TERMINAL.test(value)) environment.TERM = value;
  return Object.freeze(environment);
}

function exactLaunch(value) {
  exactKeys(value, new Set(['identity']), 'local authentication launch identity');
  if (typeof value.identity !== 'string' || !DIGEST.test(value.identity)) throw new TypeError('local authentication launch identity is invalid');
  return value.identity;
}

function exactInvocation(value) {
  exactKeys(value, new Set(['exitCode', 'signal', 'timedOut', 'aborted', 'outputTruncated', 'stdout', 'stderr']), 'local authentication invocation');
  if ((value.exitCode != null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255))
      || (value.signal != null && (typeof value.signal !== 'string' || !/^[A-Z][A-Z0-9]{0,31}$/u.test(value.signal)))
      || typeof value.timedOut !== 'boolean'
      || typeof value.aborted !== 'boolean' || typeof value.outputTruncated !== 'boolean'
      || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
      || new TextEncoder().encode(value.stdout).byteLength > 64 * 1024
      || new TextEncoder().encode(value.stderr).byteLength > 64 * 1024) {
    throw new TypeError('local authentication invocation is invalid');
  }
  return value;
}

export async function attemptLinuxCliAuthentication(value = {}, providedPorts = {}) {
  exactKeys(value, new Set(['subject']), 'local authentication attempt request');
  exactKeys(providedPorts, new Set(['observe', 'observeLaunch', 'invoke', 'readTerminalType', 'signal']), 'local authentication attempt ports');
  if (!value.subject || typeof value.subject !== 'object' || Array.isArray(value.subject)) {
    throw new TypeError('local authentication subject is invalid');
  }
  frozenJson(value.subject);
  const input = `${JSON.stringify(value.subject)}\n`;
  if (new TextEncoder().encode(input).byteLength > MAX_SUBJECT_BYTES) throw new TypeError('local authentication subject is too large');
  const ports = Object.freeze({
    observe: providedPorts.observe ?? observeLinuxCliAuthentication,
    observeLaunch: providedPorts.observeLaunch ?? inspectFixedLaunch,
    invoke: providedPorts.invoke ?? invokeCommand,
    readTerminalType: providedPorts.readTerminalType ?? (() => process.env.TERM),
    signal: providedPorts.signal ?? null,
  });
  for (const [name, port] of Object.entries(ports)) {
    if (name !== 'signal' && typeof port !== 'function') throw new TypeError(`local authentication ${name} port is invalid`);
  }
  if (ports.signal != null && typeof ports.signal !== 'object') throw new TypeError('local authentication signal is invalid');

  let before;
  let launchBefore;
  try {
    before = exactObservation(await ports.observe());
    if (!before.ready) return unavailable(before.reason);
    launchBefore = exactLaunch(await ports.observeLaunch());
  } catch {
    return unavailable('identity-unavailable');
  }

  let terminalType = null;
  try { terminalType = await ports.readTerminalType(); }
  catch {}
  let attemptStarted = false;
  let invoked = null;
  try {
    attemptStarted = true;
    invoked = await ports.invoke({
      executable: PROGRAM,
      arguments: ['--', process.execPath, ENTRY],
      input,
      timeoutMs: 5 * 60_000,
      maxOutputBytes: 64 * 1024,
      environment: minimalEnvironment(terminalType),
      signal: ports.signal,
    });
  } catch {}

  let after;
  let launchAfter;
  try {
    after = exactObservation(await ports.observe());
    launchAfter = exactLaunch(await ports.observeLaunch());
  } catch {
    return unavailable('identity-unverified', { attempted: attemptStarted });
  }
  if (!after.ready || after.identity !== before.identity || launchAfter !== launchBefore) {
    return unavailable('identity-changed', { attempted: attemptStarted });
  }
  if (invoked == null) return unavailable('attempt-failed', { attempted: attemptStarted });

  let selected;
  try { selected = exactInvocation(invoked); }
  catch { return unavailable('result-invalid', { attempted: true }); }
  if (selected.aborted) return unavailable('cancelled', { attempted: true });
  if (selected.timedOut) return unavailable('timed-out', { attempted: true });
  if (selected.outputTruncated) return unavailable('result-invalid', { attempted: true });
  if (selected.exitCode !== 0 || selected.signal != null) return unavailable('not-completed', { attempted: true });
  return attemptResult({ attempted: true, completed: true, reason: null });
}

export {
  ATTEMPT_PROTOCOL as LOCAL_AUTHENTICATION_ATTEMPT_PROTOCOL,
  OBSERVATION_PROTOCOL as LOCAL_AUTHENTICATION_OBSERVATION_PROTOCOL,
};
