import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

const MAX_PROVIDER_OUTPUT = 1024 * 1024;
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const RUNNER_SOURCE = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const specPath = process.argv[2];
const resultPath = process.argv[3];
function tail(current, chunk, limit) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= limit ? { value: next, truncated: false } : { value: next.subarray(next.length - limit), truncated: true };
}
(async () => {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let truncated = false;
  child.stdout.on('data', (chunk) => { const next = tail(stdout, chunk, spec.maxOutputBytes); stdout = next.value; truncated ||= next.truncated; });
  child.stderr.on('data', (chunk) => { const next = tail(stderr, chunk, spec.maxOutputBytes); stderr = next.value; truncated ||= next.truncated; });
  if (spec.stdinBase64 == null) child.stdin.end(); else child.stdin.end(Buffer.from(spec.stdinBase64, 'base64'));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, spec.timeoutMs);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
  fs.writeFileSync(resultPath, JSON.stringify({ exitCode: exit.code, signal: exit.signal, timedOut, outputTruncated: truncated, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') }));
})().catch((error) => { try { fs.writeFileSync(resultPath, JSON.stringify({ providerError: error?.stack ?? String(error) })); } catch {} process.exitCode = 1; });
`;
const PROBE_SOURCE = String.raw`
(async () => {
  const fs = require('node:fs');
  const net = require('node:net');
  const [workspace, outsideRead, outsideWrite, stateRead, outsideSecret, stateSecret] = process.argv.slice(1);
  const result = {};
  try { fs.writeFileSync(workspace + '\\allowed-write.txt', 'ok'); result.allowedWrite = true; } catch { result.allowedWrite = false; }
  try { result.outsideReadDenied = fs.readFileSync(outsideRead, 'utf8') !== outsideSecret; } catch { result.outsideReadDenied = true; }
  try { fs.writeFileSync(outsideWrite, 'escape'); result.outsideWriteAttempted = true; } catch { result.outsideWriteAttempted = false; }
  try { result.stateReadDenied = fs.readFileSync(stateRead, 'utf8') !== stateSecret; } catch { result.stateReadDenied = true; }
  result.gitAbsent = !fs.existsSync(workspace + '\\.git');
  result.networkDenied = await new Promise((resolve) => {
    let settled = false; let timer = null;
    const socket = net.createConnection({ host: '1.1.1.1', port: 53 });
    const finish = (value) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(false)); socket.once('error', () => finish(true)); timer = setTimeout(() => finish(true), 1200);
  });
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
`;

function appendTail(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  if (combined.length <= maxBytes) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - maxBytes), truncated: true };
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function isWithin(root, candidate) {
  const relative = path.win32.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative));
}

function normalizeHostPath(value) {
  return path.win32.normalize(path.win32.resolve(value));
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function directoryDescriptor(candidate, writable) {
  const destination = normalizeHostPath(candidate);
  if (destination === path.win32.parse(destination).root) throw new PolicyError('Windows Sandbox roots may not expose an entire drive');
  const info = await lstat(destination);
  if (info.isSymbolicLink()) throw new PolicyError('Windows Sandbox mapped roots may not be symbolic links or junctions');
  const host = await realpath(destination);
  const realInfo = await lstat(host);
  if (!realInfo.isDirectory()) throw new PolicyError('Windows Sandbox mapped roots must be directories');
  return { host: normalizeHostPath(host), writable };
}

function containsProtected(mapping, protectedRoots) {
  return protectedRoots.some((protectedRoot) => isWithin(mapping.host, protectedRoot) || isWithin(protectedRoot, mapping.host));
}

function dedupeMappings(mappings) {
  const ordered = [...mappings].sort((left, right) => right.host.length - left.host.length || left.host.localeCompare(right.host));
  const result = [];
  for (const mapping of ordered) {
    const covering = result.find((entry) => isWithin(entry.host, mapping.host));
    if (!covering) result.push(mapping);
    else if (mapping.writable && !covering.writable) throw new PolicyError('Windows Sandbox writable root is nested under a read-only mapping');
  }
  return result;
}

function sandboxPath(index, writable) { return `C:\\PatchPoller\\${writable ? 'w' : 'r'}${index}`; }

function mapHostPath(value, mappings) {
  const absolute = normalizeHostPath(value);
  const match = [...mappings].sort((left, right) => right.host.length - left.host.length).find((entry) => isWithin(entry.host, absolute));
  if (!match) return null;
  const relative = path.win32.relative(match.host, absolute);
  return relative ? path.win32.join(match.sandbox, relative) : match.sandbox;
}

function rewriteArg(value, mappings) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value)) return value;
  return mapHostPath(value, mappings) ?? value;
}

function rewriteEnvironment(env, mappings) {
  const result = {
    CI: '1', GIT_TERMINAL_PROMPT: '0', PATCH_POLLER_NONINTERACTIVE: '1', NO_COLOR: '1',
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SystemDrive: 'C:',
    USERPROFILE: 'C:\\Users\\WDAGUtilityAccount', TEMP: 'C:\\Temp', TMP: 'C:\\Temp',
  };
  const sourcePath = env.Path ?? env.PATH ?? '';
  const mapped = sourcePath.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => path.win32.isAbsolute(entry) ? mapHostPath(entry, mappings) : null).filter(Boolean);
  result.Path = [...new Set(['C:\\Windows\\System32', 'C:\\Windows', ...mapped])].join(';');
  for (const [key, value] of Object.entries(env)) {
    if (['PATH', 'Path', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive'].includes(key)) continue;
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function configurationXml(mappings) {
  const folders = mappings.map((entry) => `<MappedFolder><HostFolder>${xmlEscape(entry.host)}</HostFolder><SandboxFolder>${xmlEscape(entry.sandbox)}</SandboxFolder><ReadOnly>${entry.writable ? 'false' : 'true'}</ReadOnly></MappedFolder>`).join('');
  return `<Configuration><VGpu>Disable</VGpu><Networking>Disable</Networking><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ClipboardRedirection>Disable</ClipboardRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders>${folders}</MappedFolders></Configuration>`;
}

function parseSandboxId(text) {
  const trimmed = String(text ?? '').trim();
  try {
    const parsed = JSON.parse(trimmed);
    const queue = [parsed];
    while (queue.length) {
      const value = queue.shift();
      if (typeof value === 'string' && GUID_RE.test(value)) return value.match(GUID_RE)[0];
      if (value && typeof value === 'object') queue.push(...Object.values(value));
    }
  } catch {}
  return trimmed.match(GUID_RE)?.[0] ?? null;
}

async function runHost({ executable, args, timeoutMs, maxOutputBytes = MAX_PROVIDER_OUTPUT }) {
  const child = spawn(executable, args, containedSpawnOptions({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let outputTruncated = false;
  child.stdout.on('data', (chunk) => { const next = appendTail(stdout, chunk, maxOutputBytes); stdout = next.buffer; outputTruncated ||= next.truncated; });
  child.stderr.on('data', (chunk) => { const next = appendTail(stderr, chunk, maxOutputBytes); stderr = next.buffer; outputTruncated ||= next.truncated; });
  let timedOut = false; let termination = null;
  const timer = setTimeout(() => { timedOut = true; termination = terminateProcessTree(child); }, timeoutMs); timer.unref?.();
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }).finally(async () => { clearTimeout(timer); if (termination) await termination; });
  return { exitCode: exit.code, signal: exit.signal, timedOut, outputTruncated, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
}

function unavailable(reason = 'Windows Sandbox provider has not been verified') {
  return { provider: 'windows-sandbox', configured: true, verified: false, filesystem: false, network: false, workerIdentity: false, reason };
}

export class WindowsSandboxProvider {
  name = 'windows-sandbox';
  #config; #env; #resolver; #protectedRoots; #cachedStatus = null; #wsb = null;

  constructor({ config = {}, env = process.env, executableResolver = resolveExecutable, protectedRoots = [] } = {}) {
    this.#config = { executable: config.executable ?? 'wsb', readRoots: Array.isArray(config.readRoots) ? [...config.readRoots] : [], verificationTimeoutMs: config.verificationTimeoutMs ?? 120_000 };
    this.#env = env; this.#resolver = executableResolver; this.#protectedRoots = protectedRoots.map(normalizeHostPath);
  }

  status() { return this.#cachedStatus ? { ...this.#cachedStatus } : unavailable(); }
  async #resolveWsb() { if (!this.#wsb) this.#wsb = await this.#resolver(this.#config.executable, this.#env); return this.#wsb; }

  async #prepareMappings(request, exchangeDir) {
    const writableValues = request.sandbox?.writableRoots ?? [];
    const readonlyValues = request.sandbox?.readOnlyRoots ?? [];
    if (!writableValues.length) throw new PolicyError('repository-code execution requires an owned writable worker root');
    const cwd = normalizeHostPath(request.cwd);
    if (await exists(path.win32.join(cwd, '.git'))) throw new PolicyError('Windows Sandbox worker root must not expose Git administrative state');
    const raw = [];
    for (const value of writableValues) raw.push(await directoryDescriptor(value, true));
    for (const value of [...this.#config.readRoots, ...readonlyValues, path.win32.dirname(request.executable), path.win32.dirname(process.execPath)]) if (await exists(value)) raw.push(await directoryDescriptor(value, false));
    raw.push(await directoryDescriptor(exchangeDir, true));
    const deduped = dedupeMappings(raw);
    for (const mapping of deduped) if (containsProtected(mapping, this.#protectedRoots)) throw new PolicyError('Windows Sandbox mapping would expose a protected control-plane root');
    const mappings = deduped.map((entry, index) => ({ ...entry, sandbox: sandboxPath(index, entry.writable) }));
    if (!mappings.some((entry) => entry.writable && isWithin(entry.host, cwd))) throw new PolicyError('Windows Sandbox cwd must be inside an owned writable root');
    return mappings;
  }

  async #runSession(request) {
    if (process.platform !== 'win32') throw new PolicyError('Windows Sandbox provider is supported only on Windows');
    const wsb = await this.#resolveWsb();
    const exchangeDir = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-wsb-'));
    let sandboxId = null;
    try {
      const runnerHost = path.join(exchangeDir, 'runner.cjs'); const specHost = path.join(exchangeDir, 'spec.json'); const resultHost = path.join(exchangeDir, 'result.json');
      await writeFile(runnerHost, RUNNER_SOURCE, { encoding: 'utf8', mode: 0o600 });
      const mappings = await this.#prepareMappings(request, exchangeDir);
      const mappedExecutable = mapHostPath(request.executable, mappings); const mappedCwd = mapHostPath(request.cwd, mappings); const mappedNode = mapHostPath(process.execPath, mappings);
      const mappedRunner = mapHostPath(runnerHost, mappings); const mappedSpec = mapHostPath(specHost, mappings); const mappedResult = mapHostPath(resultHost, mappings);
      if (![mappedExecutable, mappedCwd, mappedNode, mappedRunner, mappedSpec, mappedResult].every(Boolean)) throw new PolicyError('Windows Sandbox mapping could not represent required execution paths');
      const spec = { executable: mappedExecutable, args: request.args.map((entry) => rewriteArg(entry, mappings)), cwd: mappedCwd, env: rewriteEnvironment(request.env ?? {}, mappings), timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes, stdinBase64: request.stdin == null ? null : Buffer.from(String(request.stdin), 'utf8').toString('base64') };
      await writeFile(specHost, `${JSON.stringify(spec)}\n`, { encoding: 'utf8', mode: 0o600 });
      const start = await runHost({ executable: wsb, args: ['start', '--raw', '--config', configurationXml(mappings)], timeoutMs: this.#config.verificationTimeoutMs });
      if (start.exitCode !== 0 || start.timedOut) throw new PolicyError(`Windows Sandbox start failed: ${start.stderr || start.stdout || 'no output'}`);
      sandboxId = parseSandboxId(start.stdout);
      if (!sandboxId) throw new PolicyError('Windows Sandbox start did not return a sandbox ID');
      const exec = await runHost({ executable: wsb, args: ['exec', '--raw', '--id', sandboxId, '-c', mappedNode, '-r', 'System', '-d', mappedCwd, mappedRunner, mappedSpec, mappedResult], timeoutMs: request.timeoutMs + 30_000 });
      if (exec.timedOut || exec.exitCode !== 0) throw new PolicyError(`Windows Sandbox exec failed: ${exec.stderr || exec.stdout || `exit ${exec.exitCode}`}`);
      const resultInfo = await stat(resultHost).catch(() => null);
      if (!resultInfo?.isFile() || resultInfo.size > MAX_PROVIDER_OUTPUT) throw new PolicyError('Windows Sandbox worker did not produce a bounded result');
      let result; try { result = JSON.parse(await readFile(resultHost, 'utf8')); } catch (error) { throw new PolicyError(`Windows Sandbox result is invalid JSON: ${error.message}`); }
      if (result.providerError) throw new PolicyError(`Windows Sandbox worker failed: ${result.providerError}`);
      const now = new Date().toISOString();
      return { ...result, startedAt: now, finishedAt: now, lastOutputAt: result.stdout || result.stderr ? now : null };
    } finally {
      if (sandboxId) await runHost({ executable: wsb, args: ['stop', '--raw', '--id', sandboxId], timeoutMs: 30_000 }).catch(() => {});
      await rm(exchangeDir, { recursive: true, force: true });
    }
  }

  async run(request) { return this.#runSession(request); }

  async verify() {
    if (this.#cachedStatus) return { ...this.#cachedStatus };
    if (process.platform !== 'win32') { this.#cachedStatus = unavailable('Windows Sandbox is not supported on this host platform'); return { ...this.#cachedStatus }; }
    const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-wsb-probe-'));
    try {
      const workspace = path.join(probeRoot, 'workspace'); const outside = path.join(probeRoot, 'outside'); const control = path.join(probeRoot, 'control');
      await Promise.all([mkdir(workspace), mkdir(outside), mkdir(control)]);
      const outsideRead = path.join(outside, 'outside-read.txt'); const outsideWrite = path.join(outside, 'outside-write.txt'); const stateRead = path.join(control, 'state-read.txt');
      const outsideSecret = randomUUID(); const stateSecret = randomUUID();
      await writeFile(outsideRead, outsideSecret, 'utf8'); await writeFile(stateRead, stateSecret, 'utf8');
      const observed = await this.#runSession({ executable: process.execPath, args: ['-e', PROBE_SOURCE, workspace, outsideRead, outsideWrite, stateRead, outsideSecret, stateSecret], cwd: workspace, env: {}, timeoutMs: 20_000, maxOutputBytes: 128 * 1024, stdin: null, sandbox: { writableRoots: [workspace], readOnlyRoots: [] } });
      const line = String(observed.stdout ?? '').trim().split(/\r?\n/u).filter(Boolean).at(-1);
      let probe; try { probe = JSON.parse(line ?? ''); } catch { probe = null; }
      const outsideWriteEscaped = await exists(outsideWrite);
      const filesystem = observed.exitCode === 0 && probe?.allowedWrite === true && probe.outsideReadDenied === true && probe.stateReadDenied === true && probe.gitAbsent === true && outsideWriteEscaped === false;
      const network = filesystem && probe?.networkDenied === true;
      const workerIdentity = filesystem;
      const verified = filesystem && network && workerIdentity;
      this.#cachedStatus = { provider: 'windows-sandbox', configured: true, verified, filesystem, network, workerIdentity, reason: verified ? null : 'Windows Sandbox boundary probe did not prove all required controls' };
    } catch (error) {
      this.#cachedStatus = unavailable(`Windows Sandbox verification failed: ${error.message}`);
    } finally { await rm(probeRoot, { recursive: true, force: true }); }
    return { ...this.#cachedStatus };
  }
}

export const windowsSandboxInternalsForTests = { configurationXml, parseSandboxId };
