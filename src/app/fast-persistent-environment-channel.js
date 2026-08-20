import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { EnvironmentBridge } from '../runtime/environment-bridge.js';

const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/u;
const MAX_FRAME_BYTES = 44 * 1024;
const MAX_RESPONSE_BYTES = 7 * 1024 * 1024;

function bounded(value, name, maxBytes = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`);
  return value;
}

async function regularFile(value, name) {
  const lexical = bounded(value, name);
  const info = await lstat(lexical);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a real regular file`);
  return realpath(lexical);
}

async function connectionAccess(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.family !== 'linux') throw new Error('fast persistent channel requires Linux guest access');
  if (typeof raw.user !== 'string' || !USER.test(raw.user)) throw new TypeError('fast persistent channel user is invalid');
  if (typeof raw.address !== 'string' || !ADDRESS.test(raw.address)) throw new TypeError('fast persistent channel address is invalid');
  const [identityFile, knownHostsFile] = await Promise.all([
    regularFile(raw.identityFile, 'fast persistent channel identity file'),
    regularFile(raw.knownHostsFile, 'fast persistent channel known-hosts file'),
  ]);
  return { user: raw.user, address: raw.address, identityFile, knownHostsFile };
}

function processReferences(child, referenced) {
  const method = referenced ? 'ref' : 'unref';
  child[method]?.();
  child.stdin?.[method]?.();
  child.stdout?.[method]?.();
  child.stderr?.[method]?.();
}

function createLineSession({ target, selected, spawnProcess, agentPath, onClose }) {
  const child = spawnProcess('ssh.exe', [
    '-F', 'NUL', '-T',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${selected.knownHostsFile}`, '-o', 'GlobalKnownHostsFile=NUL',
    '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-i', selected.identityFile, `${selected.user}@${selected.address}`,
    'env', `DEVBRIDGE_GUEST_TARGET=${target}`, 'node', agentPath, '--exchange-lines',
  ], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });

  let closed = false;
  let output = Buffer.alloc(0);
  let errorText = '';
  const pending = [];

  const fail = (error) => {
    if (closed) return;
    closed = true;
    child.kill('SIGTERM');
    for (const entry of pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener?.('abort', entry.abortListener);
      entry.reject(error);
    }
    onClose();
  };

  child.stderr.on('data', (chunk) => {
    errorText = `${errorText}${Buffer.from(chunk).toString('utf8')}`.slice(-2048);
  });
  child.stdout.on('data', (chunk) => {
    if (closed) return;
    output = Buffer.concat([output, Buffer.from(chunk)]);
    while (true) {
      const newline = output.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_RESPONSE_BYTES) return fail(new Error('fast persistent channel response exceeded its limit'));
      const line = output.subarray(0, newline).toString('utf8').trim();
      output = output.subarray(newline + 1);
      const entry = pending.shift();
      if (!entry) return fail(new Error('fast persistent channel returned an unsolicited response'));
      clearTimeout(entry.timer);
      entry.signal?.removeEventListener?.('abort', entry.abortListener);
      try {
        const parsed = JSON.parse(line);
        if (entry.aborted) entry.reject(entry.signal?.reason instanceof Error ? entry.signal.reason : new Error('fast persistent channel request was aborted'));
        else entry.resolve(parsed);
      } catch (error) {
        entry.reject(new Error('fast persistent channel returned invalid structured output', { cause: error }));
      }
      if (pending.length === 0) processReferences(child, false);
    }
    if (output.length > MAX_RESPONSE_BYTES) fail(new Error('fast persistent channel response exceeded its limit'));
  });
  child.once('error', (error) => fail(error));
  child.once('close', (code, signal) => fail(new Error(`fast persistent channel closed (${code ?? signal ?? 'unknown'}): ${errorText || 'no detail'}`)));
  processReferences(child, false);

  return Object.freeze({
    exchange(frame, { signal = null } = {}) {
      if (closed) return Promise.reject(new Error('fast persistent channel is closed'));
      if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('fast persistent channel request was aborted'));
      const serialized = JSON.stringify(frame);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_FRAME_BYTES) return Promise.reject(new Error('fast persistent channel frame exceeded its limit'));
      processReferences(child, true);
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, aborted: false, timer: null, abortListener: null };
        entry.abortListener = () => { entry.aborted = true; };
        signal?.addEventListener?.('abort', entry.abortListener, { once: true });
        entry.timer = setTimeout(() => fail(new Error('fast persistent channel response timed out')), 120_000);
        entry.timer.unref?.();
        pending.push(entry);
        child.stdin.write(`${serialized}\n`, 'utf8', (error) => { if (error) fail(error); });
      });
    },
  });
}

export function createFastPersistentEnvironmentChannel({
  access,
  prepare = async () => {},
  agentPath = '/usr/local/libexec/devbridge/bridge-agent.mjs',
  spawnProcess = spawn,
} = {}) {
  if (typeof access !== 'function' || typeof prepare !== 'function' || typeof spawnProcess !== 'function') throw new TypeError('fast persistent channel composition is incomplete');
  if (typeof agentPath !== 'string' || !/^\/[A-Za-z0-9._+/-]{1,4095}$/u.test(agentPath) || agentPath.includes('/../')) throw new TypeError('fast persistent channel agent path is invalid');
  const sessions = new Map();
  const exchange = async (frame, options = {}) => {
    const target = frame?.target;
    if (typeof target !== 'string' || !TARGET.test(target)) throw new TypeError('fast persistent channel target is invalid');
    let sessionPromise = sessions.get(target);
    if (!sessionPromise) {
      sessionPromise = (async () => {
        await prepare(target);
        const selected = await connectionAccess(await access(target));
        return createLineSession({
          target,
          selected,
          spawnProcess,
          agentPath,
          onClose: () => { if (sessions.get(target) === sessionPromise) sessions.delete(target); },
        });
      })();
      sessions.set(target, sessionPromise);
      sessionPromise.catch(() => { if (sessions.get(target) === sessionPromise) sessions.delete(target); });
    }
    const session = await sessionPromise;
    return session.exchange(frame, options);
  };
  return new EnvironmentBridge({ exchange });
}
