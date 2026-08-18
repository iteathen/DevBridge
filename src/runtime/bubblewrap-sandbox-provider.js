import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, lstat, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PolicyError } from '../errors.js';
import { resolveExecutable } from './executable-resolver.js';
import { containedSpawnOptions, terminateProcessTree } from './process-tree.js';

const DEFAULT_READ_ROOTS = ['/usr', '/usr/local', '/bin', '/lib', '/lib64'];
const OPTIONAL_READ_PATHS = ['/etc/ld.so.cache', '/etc/alternatives'];
const PROBE_SCRIPT = String.raw`
(async () => {
  const fs = require('node:fs'); const net = require('node:net');
  const [workspace, outsideRead, outsideWrite, stateRead, hostUserNs, hostNetNs] = process.argv.slice(1); const result = {};
  try { fs.writeFileSync(workspace + '/allowed-write.txt', 'ok'); result.allowedWrite = true; } catch { result.allowedWrite = false; }
  try { fs.readFileSync(outsideRead); result.outsideReadDenied = false; } catch { result.outsideReadDenied = true; }
  try { fs.writeFileSync(outsideWrite, 'escape'); result.outsideWriteDenied = false; } catch { result.outsideWriteDenied = true; }
  try { fs.readFileSync(stateRead); result.stateReadDenied = false; } catch { result.stateReadDenied = true; }
  result.gitAbsent = !fs.existsSync(workspace + '/.git');
  try { result.userNamespaceChanged = fs.readlinkSync('/proc/self/ns/user') !== hostUserNs; } catch { result.userNamespaceChanged = false; }
  try { result.networkNamespaceChanged = fs.readlinkSync('/proc/self/ns/net') !== hostNetNs; } catch { result.networkNamespaceChanged = false; }
  result.networkDenied = await new Promise((resolve) => { let settled = false; let timer = null; const socket = net.createConnection({ host: '1.1.1.1', port: 53 }); const finish = (value) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); socket.destroy(); resolve(value); }; socket.once('connect', () => finish(false)); socket.once('error', () => finish(true)); timer = setTimeout(() => finish(true), 750); });
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
`;
function appendTail(current, chunk, maxBytes) { const combined = Buffer.concat([current, Buffer.from(chunk)]); if (combined.length <= maxBytes) return { buffer: combined, truncated: false }; return { buffer: combined.subarray(combined.length - maxBytes), truncated: true }; }
async function exists(candidate) { try { await lstat(candidate); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
function isWithin(root, candidate) { const relative = path.relative(root, candidate); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function parentDirectories(candidate) { const result = []; let cursor = path.dirname(candidate); const root = path.parse(candidate).root; while (cursor && cursor !== root && cursor !== path.dirname(cursor)) { result.push(cursor); cursor = path.dirname(cursor); } return result.reverse(); }
function safeSandboxEnvironment(env, visibleRoots) { const result = { ...env, HOME: '/home/worker', TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp', USER: 'patchpoller-worker' }; if (typeof env.PATH === 'string') { const entries = env.PATH.split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry)).filter((entry) => visibleRoots.some((root) => isWithin(root, path.resolve(entry)))); result.PATH = [...new Set(entries)].join(':'); } return result; }
async function rootDescriptor(candidate, { writable = false } = {}) { const destination = path.resolve(candidate); if (destination === path.parse(destination).root) throw new PolicyError('sandbox roots may not expose an entire filesystem root'); const info = await lstat(destination); if (writable && info.isSymbolicLink()) throw new PolicyError('sandbox writable roots may not be symbolic links'); const host = await realpath(destination); const realInfo = await lstat(host); if (writable && !realInfo.isDirectory()) throw new PolicyError('sandbox writable roots must be directories'); return { host, destination, directory: realInfo.isDirectory() }; }
async function existingDescriptors(values, options = {}) { const result = []; for (const value of values) { if (!value || !(await exists(value))) continue; result.push(await rootDescriptor(value, options)); } return result; }
function dedupeByDestination(descriptors) { const result = []; const seen = new Set(); for (const descriptor of descriptors) { if (seen.has(descriptor.destination)) continue; seen.add(descriptor.destination); result.push(descriptor); } return result; }
function rejectProtectedExposure(descriptors, protectedRoots) { for (const descriptor of descriptors) for (const protectedRoot of protectedRoots) if (isWithin(descriptor.host, protectedRoot) || isWithin(protectedRoot, descriptor.host)) throw new PolicyError('sandbox mapping would expose a protected control-plane root'); }
async function runLocal({ executable, args, cwd, env, timeoutMs, maxOutputBytes }) { const child = spawn(executable, args, containedSpawnOptions({ cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })); let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let outputTruncated = false; child.stdout.on('data', (chunk) => { const next = appendTail(stdout, chunk, maxOutputBytes); stdout = next.buffer; outputTruncated ||= next.truncated; }); child.stderr.on('data', (chunk) => { const next = appendTail(stderr, chunk, maxOutputBytes); stderr = next.buffer; outputTruncated ||= next.truncated; }); let timedOut = false; let termination = null; const timer = setTimeout(() => { timedOut = true; termination = terminateProcessTree(child); }, timeoutMs); timer.unref?.(); const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }).finally(async () => { clearTimeout(timer); if (termination) await termination; }); return { exitCode: exit.code, signal: exit.signal, timedOut, outputTruncated, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') }; }
function status(reason = 'sandbox provider has not been verified') { return { provider: 'bubblewrap', configured: true, verified: false, filesystem: false, network: false, workerIdentity: false, reason }; }

export class BubblewrapSandboxProvider {
  name = 'bubblewrap'; #config; #env; #resolver; #protectedRoots; #cachedStatus = null; #executable = null;
  constructor({ config = {}, env = process.env, executableResolver = resolveExecutable, protectedRoots = [] } = {}) { this.#config = { executable: config.executable ?? 'bwrap', readRoots: Array.isArray(config.readRoots) ? [...config.readRoots] : [], verificationTimeoutMs: config.verificationTimeoutMs ?? 20_000 }; this.#env = env; this.#resolver = executableResolver; this.#protectedRoots = protectedRoots.map((entry) => path.resolve(entry)); }
  status() { return this.#cachedStatus ? { ...this.#cachedStatus } : status(); }
  async #resolveProviderExecutable() { if (!this.#executable) this.#executable = await this.#resolver(this.#config.executable, this.#env); return this.#executable; }
  async prepareLaunch(request) {
    if (process.platform !== 'linux') throw new PolicyError('bubblewrap sandbox provider is supported only on Linux');
    if (!request || typeof request !== 'object') throw new PolicyError('sandbox execution request is required');
    const requested = request.sandbox ?? {}; const writableValues = Array.isArray(requested.writableRoots) ? requested.writableRoots : []; const readonlyValues = Array.isArray(requested.readOnlyRoots) ? requested.readOnlyRoots : [];
    if (writableValues.length === 0) throw new PolicyError('repository-code execution requires at least one locally owned writable root');
    const cwd = path.resolve(request.cwd); if (await exists(path.join(cwd, '.git'))) throw new PolicyError('sandbox worker root must not expose Git administrative state');
    const writable = dedupeByDestination(await existingDescriptors(writableValues, { writable: true })); if (!writable.some((entry) => isWithin(entry.destination, cwd))) throw new PolicyError('sandbox cwd must be inside an owned writable root');
    const providerExecutable = await this.#resolveProviderExecutable(); const targetExecutable = await realpath(request.executable);
    const readonly = dedupeByDestination(await existingDescriptors([...DEFAULT_READ_ROOTS, ...OPTIONAL_READ_PATHS, ...this.#config.readRoots, ...readonlyValues, path.dirname(targetExecutable)]));
    const protectedReal = []; for (const value of this.#protectedRoots) if (await exists(value)) protectedReal.push(await realpath(value)); rejectProtectedExposure([...writable, ...readonly], protectedReal);
    const visibleRoots = [...writable, ...readonly].map((entry) => entry.destination); const targetEnv = safeSandboxEnvironment(request.env ?? {}, visibleRoots); const parentDirs = new Set(['/home', '/home/worker']);
    for (const descriptor of [...readonly, ...writable]) { for (const parent of parentDirectories(descriptor.destination)) parentDirs.add(parent); if (descriptor.directory) parentDirs.add(descriptor.destination); }
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
    for (const directory of [...parentDirs].sort((left, right) => left.length - right.length || left.localeCompare(right))) if (directory !== '/tmp' && directory !== '/proc' && directory !== '/dev') args.push('--dir', directory);
    for (const descriptor of readonly) args.push('--ro-bind', descriptor.host, descriptor.destination); for (const descriptor of writable) args.push('--bind', descriptor.host, descriptor.destination); for (const [key, value] of Object.entries(targetEnv).sort(([left], [right]) => left.localeCompare(right))) args.push('--setenv', key, String(value)); args.push('--chdir', cwd, '--', targetExecutable, ...request.args);
    return { executable: providerExecutable, args, cwd, env: { PATH: this.#env.PATH ?? '/usr/bin:/bin' } };
  }
  async run(request, delegate) { const launch = await this.prepareLaunch(request); return delegate({ ...request, ...launch }); }
  async verify() {
    if (this.#cachedStatus) return { ...this.#cachedStatus }; if (process.platform !== 'linux') { this.#cachedStatus = status('bubblewrap is not supported on this host platform'); return { ...this.#cachedStatus }; }
    const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'patch-poller-bwrap-probe-'));
    try {
      const workspace = path.join(probeRoot, 'workspace'); const outside = path.join(probeRoot, 'outside'); const control = path.join(probeRoot, 'control'); await Promise.all([mkdir(workspace), mkdir(outside), mkdir(control)]);
      const outsideRead = path.join(outside, 'read-secret.txt'); const outsideWrite = path.join(outside, 'write-sentinel.txt'); const stateRead = path.join(control, 'state-secret.txt'); await writeFile(outsideRead, 'outside-secret', 'utf8'); await writeFile(stateRead, 'control-secret', 'utf8');
      const [hostUserNs, hostNetNs] = await Promise.all([readlink('/proc/self/ns/user'), readlink('/proc/self/ns/net')]);
      const request = { executable: process.execPath, args: ['-e', PROBE_SCRIPT, workspace, outsideRead, outsideWrite, stateRead, hostUserNs, hostNetNs], cwd: workspace, env: { PATH: this.#env.PATH ?? '/usr/bin:/bin' }, sandbox: { writableRoots: [workspace], readOnlyRoots: [] } };
      const launch = await this.prepareLaunch(request); const observed = await runLocal({ ...launch, timeoutMs: this.#config.verificationTimeoutMs, maxOutputBytes: 128 * 1024 }); const line = observed.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1); let probe; try { probe = JSON.parse(line ?? ''); } catch { probe = null; }
      const filesystem = observed.exitCode === 0 && probe?.allowedWrite === true && probe.outsideReadDenied === true && probe.outsideWriteDenied === true && probe.stateReadDenied === true && probe.gitAbsent === true; const network = filesystem && probe?.networkNamespaceChanged === true && probe.networkDenied === true; const workerIdentity = filesystem && probe?.userNamespaceChanged === true; const verified = filesystem && network && workerIdentity;
      this.#cachedStatus = { provider: 'bubblewrap', configured: true, verified, filesystem, network, workerIdentity, reason: verified ? null : `bubblewrap boundary probe failed${observed.stderr ? `: ${observed.stderr.slice(-400)}` : ''}` };
    } catch (error) { this.#cachedStatus = status(`bubblewrap verification failed: ${error.message}`); } finally { await rm(probeRoot, { recursive: true, force: true }); }
    return { ...this.#cachedStatus };
  }
}
