import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { UBUNTU_APT_ISOLATED_CONFIGURATION } from './ubuntu-apt-transaction-solver.mjs';
import { sameFilesystemIdentity } from '../runtime/local-filesystem-identity.js';

const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const TOKEN = /^[a-z0-9][a-z0-9.-]{0,99}$/u;
const ARCHITECTURE = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${name} is invalid`);
  return path.resolve(value);
}

function runProcess(executable, args, { environment, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
      signal: signal ?? undefined,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const collect = (target, field) => (chunk) => {
      if (field === 'stdout') stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if ((field === 'stdout' ? stdoutBytes : stderrBytes) > MAX_OUTPUT_BYTES) { overflow = true; child.kill(); return; }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout, 'stdout'));
    child.stderr.on('data', collect(stderr, 'stderr'));
    child.once('error', reject);
    child.once('close', (code, childSignal) => {
      if (overflow) { reject(new Error('Ubuntu snapshot APT update output exceeded its bound')); return; }
      resolve(Object.freeze({
        code, signal: childSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    });
  });
}

async function directTool(location) {
  const selected = absolutePath(location, 'apt-get executable path');
  if (!await sameFilesystemIdentity(selected, await realpath(selected))) fail('apt-get executable must use a direct nonsymbolic path');
  const info = await lstat(selected, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1n || info.size > 256n * 1024n * 1024n) {
    fail('apt-get executable must be one bounded regular file');
  }
  return selected;
}

function expectedNames(snapshot, codename, architecture) {
  const prefix = `snapshot.ubuntu.com_ubuntu_${snapshot}_dists_`;
  return new Set([
    `${prefix}${codename}-security_InRelease`,
    `${prefix}${codename}-security_main_binary-${architecture}_Packages`,
    `${prefix}${codename}-security_universe_binary-${architecture}_Packages`,
    `${prefix}${codename}-updates_InRelease`,
    `${prefix}${codename}-updates_main_binary-${architecture}_Packages`,
    `${prefix}${codename}-updates_universe_binary-${architecture}_Packages`,
    `${prefix}${codename}_InRelease`,
    `${prefix}${codename}_main_binary-${architecture}_Packages`,
    `${prefix}${codename}_universe_binary-${architecture}_Packages`,
  ]);
}

function environmentFor(configurationFile) {
  const environment = { LANG: 'C', LC_ALL: 'C', APT_CONFIG: configurationFile };
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function failure(result) {
  const detail = typeof result?.stderr === 'string'
    ? result.stderr.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '?').slice(-2048)
    : '';
  return `Ubuntu exact-snapshot APT update failed (exit ${Number.isInteger(result?.code) ? result.code : 'invalid'}${result?.signal ? `, signal ${result.signal}` : ''})${detail ? `: ${detail}` : ''}`;
}

export class UbuntuSnapshotAptLists {
  constructor(raw = {}) {
    const value = exactObject(raw, new Set(['executable', 'run']), 'Ubuntu snapshot APT-list options');
    this.executable = absolutePath(value.executable, 'apt-get executable path');
    this.run = value.run ?? runProcess;
    if (typeof this.run !== 'function') throw new TypeError('Ubuntu snapshot APT-list runner port is invalid');
  }

  async prepare(raw = {}) {
    const request = exactObject(raw, new Set([
      'destination', 'statusFile', 'keyringFile', 'sources', 'codename', 'architecture', 'snapshot', 'signal',
    ]), 'Ubuntu snapshot APT-list request');
    const destination = absolutePath(request.destination, 'Ubuntu snapshot APT-list destination');
    const statusFile = absolutePath(request.statusFile, 'Ubuntu dpkg status path');
    absolutePath(request.keyringFile, 'Ubuntu archive keyring path');
    if (typeof request.sources !== 'string' || request.sources.length < 1 || Buffer.byteLength(request.sources, 'utf8') > 1024 * 1024
        || typeof request.codename !== 'string' || !TOKEN.test(request.codename)
        || typeof request.architecture !== 'string' || !ARCHITECTURE.test(request.architecture)
        || typeof request.snapshot !== 'string' || !SNAPSHOT.test(request.snapshot)) {
      throw new TypeError('Ubuntu snapshot APT-list authority is invalid');
    }
    if (request.signal != null && typeof request.signal !== 'object') throw new TypeError('Ubuntu snapshot APT-list signal is invalid');
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('Ubuntu snapshot APT-list preparation was interrupted');
    const executable = await directTool(this.executable);
    const configurationFile = path.join(destination, 'apt.conf');
    const sourcesListFile = path.join(destination, 'sources.list');
    const sourcePartsDirectory = path.join(destination, 'source-parts');
    const listsDirectory = path.join(destination, 'lists');
    await Promise.all([mkdir(sourcePartsDirectory), mkdir(listsDirectory)]);
    await Promise.all([
      writeFile(configurationFile, UBUNTU_APT_ISOLATED_CONFIGURATION, { flag: 'wx', mode: 0o600 }),
      writeFile(sourcesListFile, request.sources, { flag: 'wx', mode: 0o600 }),
    ]);
    const args = [
      '-o', `Dir::State::status=${statusFile}`,
      '-o', `Dir::State::lists=${listsDirectory}`,
      '-o', `Dir::Etc::sourcelist=${sourcesListFile}`,
      '-o', `Dir::Etc::sourceparts=${sourcePartsDirectory}`,
      '-o', 'Dir::Etc::preferences=/dev/null',
      '-o', 'Dir::Etc::preferencesparts=/dev/null',
      '-o', 'Dir::State::extended_states=/dev/null',
      '-o', 'Dir::Cache::pkgcache=',
      '-o', 'Dir::Cache::srcpkgcache=',
      '-o', 'Debug::NoLocking=true',
      '-o', 'Acquire::Languages=none',
      '-o', 'Acquire::IndexTargets::deb::CNF::DefaultEnabled=false',
      '-o', 'Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false',
      '--error-on=any', '--snapshot', request.snapshot, 'update', '--quiet=2',
    ];
    const result = await this.run(executable, args, {
      environment: environmentFor(configurationFile),
      signal: request.signal ?? null,
    });
    if (!result || result.code !== 0 || result.signal != null || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      fail(failure(result));
    }
    await Promise.all([
      rm(path.join(listsDirectory, 'partial'), { recursive: true, force: true }),
      rm(path.join(listsDirectory, 'auxfiles'), { recursive: true, force: true }),
      rm(path.join(listsDirectory, 'lock'), { force: true }),
    ]);
    const expected = expectedNames(request.snapshot, request.codename, request.architecture);
    for (const entry of await readdir(listsDirectory, { withFileTypes: true })) {
      if (expected.has(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) fail('Ubuntu snapshot APT update returned an unsupported list entry');
      await unlink(path.join(listsDirectory, entry.name));
    }
    return Object.freeze({ configurationFile, sourcesListFile, sourcePartsDirectory, listsDirectory });
  }
}
