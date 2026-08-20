import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PROTOCOL = 'devbridge/environment-bootstrap-v1';
const STATE_PROTOCOL = 'devbridge/environment-bootstrap-state-v1';
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const REQUEST = /^[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REQUIREMENTS = 64;
const MAX_PROTECTED = 64;
const MAX_PATH_DIRECTORIES = 64;

const CAPABILITIES = Object.freeze({
  'source-control': [
    { names: process.platform === 'win32' ? ['git.exe', 'git'] : ['git'], args: ['--version'] },
  ],
  'runtime-js': [
    { names: ['node', 'node.exe'], args: ['--version'] },
  ],
  'build-config': [
    { names: ['cmake', 'cmake.exe'], args: ['--version'] },
  ],
  'test-runner': [
    { names: ['ctest', 'ctest.exe'], args: ['--version'] },
  ],
  'compiler-c': process.platform === 'win32'
    ? [{ names: ['cl.exe', 'cl'], args: ['/?'] }, { names: ['clang.exe', 'clang'], args: ['--version'] }, { names: ['gcc.exe', 'gcc'], args: ['--version'] }]
    : [{ names: ['cc'], args: ['--version'] }, { names: ['clang'], args: ['--version'] }, { names: ['gcc'], args: ['--version'] }],
  'compiler-cxx': process.platform === 'win32'
    ? [{ names: ['cl.exe', 'cl'], args: ['/?'] }, { names: ['clang++.exe', 'clang++'], args: ['--version'] }, { names: ['g++.exe', 'g++'], args: ['--version'] }]
    : [{ names: ['c++'], args: ['--version'] }, { names: ['clang++'], args: ['--version'] }, { names: ['g++'], args: ['--version'] }],
  'package-project': [
    { names: process.platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'], args: ['--version'], commandScript: process.platform === 'win32' },
  ],
  'package-system': process.platform === 'win32'
    ? [
        { names: ['winget.exe', 'winget'], args: ['--version'] },
        { names: ['choco.exe', 'choco'], args: ['--version'] },
      ]
    : [
        { names: ['apt-get'], args: ['--version'] },
        { names: ['dnf'], args: ['--version'] },
        { names: ['zypper'], args: ['--version'] },
        { names: ['pacman'], args: ['--version'] },
        { names: ['apk'], args: ['--version'] },
      ],
});

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function safeTarget(value) {
  if (typeof value !== 'string' || !TARGET.test(value)) throw new TypeError('bootstrap target is invalid');
  const expected = process.env.DEVBRIDGE_GUEST_TARGET;
  if (expected && expected !== value) throw new Error('bootstrap target does not match this local binding');
  return value;
}

function safeRequest(value) {
  if (typeof value !== 'string' || !REQUEST.test(value)) throw new TypeError('bootstrap request identity is invalid');
  return value;
}

function digestValue(value, name) {
  const normalized = String(value ?? '').toLowerCase();
  if (!DIGEST.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function boundedText(value, maxBytes = 2_048) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function stateRoot() {
  const configured = process.env.DEVBRIDGE_BOOTSTRAP_ROOT;
  if (configured) return path.resolve(configured);
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'DevBridge', 'bootstrap');
  return '/var/lib/devbridge/bootstrap';
}

const ROOT = stateRoot();
const STATE = path.join(ROOT, 'state.json');

async function ensureRoot() {
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  const info = await lstat(ROOT);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('bootstrap state root must be a real directory');
  return realpath(ROOT);
}

async function loadState() {
  await ensureRoot();
  try {
    const info = await lstat(STATE);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('bootstrap state record is invalid');
    const value = JSON.parse(await readFile(STATE, 'utf8'));
    if (!value || value.protocol !== STATE_PROTOCOL) throw new Error('bootstrap state protocol is invalid');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveState(value) {
  await ensureRoot();
  const temporary = path.join(ROOT, `.state-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, STATE);
}

function pathDirectories() {
  const raw = process.platform === 'win32' ? (process.env.Path ?? process.env.PATH ?? '') : (process.env.PATH ?? '');
  const entries = [];
  const seen = new Set();
  for (const item of String(raw).split(path.delimiter)) {
    if (!item || entries.length >= MAX_PATH_DIRECTORIES) continue;
    const resolved = path.resolve(item);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(resolved);
  }
  return entries;
}

async function candidatePath(names) {
  for (const directory of pathDirectories()) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        const actual = await realpath(candidate);
        const info = await lstat(actual);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        if (process.platform !== 'win32') await access(actual, fsConstants.X_OK);
        return actual;
      } catch {}
    }
  }
  return null;
}

function execute(executable, args, { commandScript = false } = {}) {
  return new Promise((resolve) => {
    const actualExecutable = process.platform === 'win32' && commandScript ? (process.env.ComSpec || 'cmd.exe') : executable;
    const tokens = [`"${executable.replaceAll('"', '""')}"`, ...args.map((value) => `"${value.replaceAll('"', '""')}"`)];
    const command = `"${tokens.join(' ')}"`;
    const actualArgs = process.platform === 'win32' && commandScript ? ['/d', '/s', '/c', command] : args;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let child;
    try {
      child = spawn(actualExecutable, actualArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32' && commandScript,
        env: process.env,
      });
    } catch (error) {
      resolve({ ok: false, reason: boundedText(error.message) });
      return;
    }
    const append = (current, chunk) => Buffer.concat([current, Buffer.from(chunk)]).subarray(0, MAX_OUTPUT_BYTES);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, reason: 'capability probe timed out' });
    }, 8_000);
    timer.unref?.();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: boundedText(error.message) });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = Buffer.concat([stdout, stderr]).toString('utf8');
      const version = boundedText(combined.split(/\r?\n/u).find((line) => line.trim()) ?? '', 512);
      // MSVC cl /? may return non-zero while still proving the compiler is usable.
      const tolerant = /(?:^|[\\/])cl(?:\.exe)?$/iu.test(executable) && version.length > 0;
      resolve({ ok: code === 0 || tolerant, version: version || null, reason: code === 0 || tolerant ? null : `capability probe exited ${code}` });
    });
  });
}

async function inspectCapability(id) {
  safeId(id, 'capability identity');
  const definitions = CAPABILITIES[id];
  if (!definitions) return { id, present: false, usable: false, version: null, reason: 'capability identity is not supported by this bootstrap agent' };
  let firstPresent = null;
  for (const definition of definitions) {
    const executable = await candidatePath(definition.names);
    if (!executable) continue;
    firstPresent ??= executable;
    const result = await execute(executable, definition.args, { commandScript: definition.commandScript === true });
    if (result.ok) return { id, present: true, usable: true, version: result.version, reason: null };
  }
  return firstPresent
    ? { id, present: true, usable: false, version: null, reason: 'capability was present but its bounded health probe failed' }
    : { id, present: false, usable: false, version: null, reason: 'capability was not found in the local executable search path' };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function inspectNetwork(required) {
  if (!required) return { nameResolution: true, secureWeb: true, reason: null };
  let nameResolution = false;
  let secureWeb = false;
  const reasons = [];
  try {
    const answers = await withTimeout(dns.resolve4('example.com'), 5_000, 'name resolution timed out');
    nameResolution = Array.isArray(answers) && answers.length > 0;
    if (!nameResolution) reasons.push('name resolution returned no address');
  } catch (error) {
    reasons.push(`name resolution failed: ${boundedText(error.message, 512)}`);
  }
  try {
    secureWeb = await withTimeout(new Promise((resolve, reject) => {
      const request = https.get('https://example.com/', { headers: { 'User-Agent': 'DevBridge-bootstrap-health/1' } }, (response) => {
        response.resume();
        resolve(Number(response.statusCode) >= 200 && Number(response.statusCode) < 500);
      });
      request.setTimeout(7_000, () => request.destroy(new Error('secure web request timed out')));
      request.once('error', reject);
    }), 8_000, 'secure web request timed out');
    if (!secureWeb) reasons.push('secure web endpoint returned an unusable status');
  } catch (error) {
    reasons.push(`secure web request failed: ${boundedText(error.message, 512)}`);
  }
  return { nameResolution, secureWeb, reason: reasons.length > 0 ? reasons.join('; ') : null };
}

function normalizeBody(raw) {
  const value = requireObject(raw, 'bootstrap request body');
  onlyKeys(value, new Set(['generation', 'basisDigest', 'revision', 'requirements', 'protectedNames', 'networkRequired']), 'bootstrap request body');
  const requirements = value.requirements;
  if (!Array.isArray(requirements) || requirements.length > MAX_REQUIREMENTS) throw new TypeError('bootstrap requirements are invalid');
  const protectedNames = value.protectedNames;
  if (!Array.isArray(protectedNames) || protectedNames.length > MAX_PROTECTED) throw new TypeError('bootstrap protected names are invalid');
  return {
    generation: digestValue(value.generation, 'bootstrap generation'),
    basisDigest: digestValue(value.basisDigest, 'bootstrap basis digest'),
    revision: safeId(value.revision, 'bootstrap revision'),
    requirements: [...new Set(requirements.map((entry) => safeId(entry, 'bootstrap requirement')))].sort(),
    protectedNames: [...new Set(protectedNames.map((entry) => {
      if (typeof entry !== 'string' || !ENV_NAME.test(entry)) throw new TypeError('bootstrap protected name is invalid');
      return entry;
    }))].sort(),
    networkRequired: value.networkRequired !== false,
  };
}

async function observation(body) {
  const [state, network, capabilities] = await Promise.all([
    loadState(),
    inspectNetwork(body.networkRequired),
    Promise.all(body.requirements.map((id) => inspectCapability(id))),
  ]);
  const protectedSet = new Set(body.protectedNames.map((entry) => process.platform === 'win32' ? entry.toUpperCase() : entry));
  const protectedPresent = Object.keys(process.env)
    .filter((entry) => protectedSet.has(process.platform === 'win32' ? entry.toUpperCase() : entry))
    .sort();
  const matching = state && state.target === process.env.DEVBRIDGE_GUEST_TARGET && state.generation === body.generation && state.basisDigest === body.basisDigest && state.revision === body.revision;
  return {
    generation: matching ? state.generation : null,
    basisDigest: matching ? state.basisDigest : null,
    revision: matching ? state.revision : null,
    network,
    capabilities,
    protectedPresent,
    reason: null,
  };
}

async function apply(target, body) {
  let observed = await observation(body);
  const usable = new Map(observed.capabilities.map((entry) => [entry.id, entry.usable]));
  const ready = (!body.networkRequired || (observed.network.nameResolution && observed.network.secureWeb))
    && body.requirements.every((id) => usable.get(id) === true)
    && observed.protectedPresent.length === 0;
  if (!ready) return { ...observed, reason: 'bootstrap prerequisites are not ready' };
  await saveState({
    protocol: STATE_PROTOCOL,
    target,
    generation: body.generation,
    basisDigest: body.basisDigest,
    revision: body.revision,
    appliedAt: new Date().toISOString(),
  });
  observed = await observation(body);
  return observed;
}

async function handle(frame) {
  const value = requireObject(frame, 'bootstrap request');
  onlyKeys(value, new Set(['protocol', 'request', 'target', 'action', 'body']), 'bootstrap request');
  if (value.protocol !== PROTOCOL) throw new TypeError('bootstrap protocol is invalid');
  const request = safeRequest(value.request);
  const target = safeTarget(value.target);
  if (!['inspect', 'apply'].includes(value.action)) throw new TypeError('bootstrap action is invalid');
  const body = normalizeBody(value.body);
  const result = value.action === 'apply' ? await apply(target, body) : await observation(body);
  return { protocol: PROTOCOL, request, target, action: value.action, ok: true, body: result };
}

function errorResponse(frame, error) {
  return {
    protocol: PROTOCOL,
    request: typeof frame?.request === 'string' ? frame.request : '0'.repeat(32),
    target: typeof frame?.target === 'string' ? frame.target : 'invalid',
    action: typeof frame?.action === 'string' ? frame.action : 'inspect',
    ok: false,
    body: {},
    error: { code: 'bootstrap-error', message: boundedText(error?.message ?? 'bootstrap request failed') },
  };
}

if (process.argv.includes('--exchange-stdin')) {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) throw new Error('bootstrap request frame is oversized');
  }
  let frame = null;
  try {
    frame = JSON.parse(raw);
    process.stdout.write(`${JSON.stringify(await handle(frame))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResponse(frame, error))}\n`);
  }
}

export { handle as handleEnvironmentBootstrapRequest };
