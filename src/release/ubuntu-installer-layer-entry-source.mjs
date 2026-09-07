import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { sameFilesystemIdentity } from '../runtime/local-filesystem-identity.js';

const TOKEN = /^[a-z0-9][a-z0-9.-]{0,99}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;
const MAX_KEYRING_BYTES = 1024 * 1024;

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

function boundedCollect(child, maximumStdout, maximumStderr) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = null;
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumStdout) { overflow = 'stdout'; child.kill(); return; }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maximumStderr) { overflow = 'stderr'; child.kill(); return; }
      stderr.push(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (overflow) { reject(new Error(`Ubuntu installer tool ${overflow} exceeded its bound`)); return; }
      resolve(Object.freeze({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    });
  });
}

function runProcess(executable, args, { signal, maximumStdout = MAX_TOOL_OUTPUT_BYTES } = {}) {
  const child = spawn(executable, args, {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { LANG: 'C', LC_ALL: 'C', PATH: process.env.PATH ?? '' },
    signal: signal ?? undefined,
  });
  return boundedCollect(child, maximumStdout, MAX_TOOL_OUTPUT_BYTES);
}

async function directTool(location, context) {
  const selected = absolutePath(location, context);
  if (!await sameFilesystemIdentity(selected, await realpath(selected))) fail(`${context} must use a direct nonsymbolic path`);
  const info = await lstat(selected, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1n || info.size > 256n * 1024n * 1024n) {
    fail(`${context} must be one bounded regular file`);
  }
  return selected;
}

function toolFailure(context, result) {
  const detail = Buffer.isBuffer(result?.stderr) ? result.stderr.toString('utf8').trim()
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '?').slice(-2048)
    : '';
  return `${context} failed (exit ${Number.isInteger(result?.code) ? result.code : 'invalid'}${result?.signal ? `, signal ${result.signal}` : ''})${detail ? `: ${detail}` : ''}`;
}

function normalizeLayers(raw, leafLayer) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) throw new TypeError('Ubuntu installer layer request is invalid');
  const layers = raw.map((value, index) => {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new TypeError(`Ubuntu installer layer ${index} is invalid`);
    return value;
  });
  if (new Set(layers).size !== layers.length || layers.at(-1) !== leafLayer) fail('Ubuntu installer layer request does not terminate at its leaf');
  return Object.freeze(layers);
}

async function selectEntry({ layers, entry, context, maximum, run, executable, signal }) {
  for (const layer of [...layers].reverse()) {
    const result = await run(executable, ['-cat', layer.location, entry], { signal, maximumStdout: maximum });
    if (result?.code === 0 && result.signal == null && Buffer.isBuffer(result.stdout) && result.stdout.byteLength > 0
        && result.stdout.byteLength <= maximum && Buffer.isBuffer(result.stderr)) {
      return Object.freeze({ layer: layer.name, bytes: result.stdout });
    }
    if (result?.signal != null) fail(toolFailure(`${context} lookup`, result));
  }
  fail(`${context} is absent from the declared installer layers`);
}

export class UbuntuInstallerLayerEntrySource {
  constructor(raw = {}) {
    const value = exactObject(raw, new Set(['xorriso', 'unsquashfs', 'run']), 'Ubuntu installer-layer source options');
    this.xorriso = absolutePath(value.xorriso, 'xorriso executable path');
    this.unsquashfs = absolutePath(value.unsquashfs, 'unsquashfs executable path');
    this.run = value.run ?? runProcess;
    if (typeof this.run !== 'function') throw new TypeError('Ubuntu installer-layer runner port is invalid');
  }

  async materialize(raw = {}) {
    const request = exactObject(raw, new Set([
      'destination', 'media', 'mediaSha256', 'mediaBytes', 'installSource', 'leafLayer', 'orderedLayers', 'signal',
    ]), 'Ubuntu installer-layer materialization request');
    const destination = absolutePath(request.destination, 'Ubuntu installer-layer destination');
    const media = absolutePath(request.media, 'Ubuntu installer media');
    if (typeof request.mediaSha256 !== 'string' || !SHA256.test(request.mediaSha256)
        || !Number.isSafeInteger(request.mediaBytes) || request.mediaBytes < 1
        || typeof request.installSource !== 'string' || !TOKEN.test(request.installSource)
        || typeof request.leafLayer !== 'string' || !TOKEN.test(request.leafLayer)) {
      throw new TypeError('Ubuntu installer-layer authority is invalid');
    }
    const names = normalizeLayers(request.orderedLayers, request.leafLayer);
    if (request.signal != null && typeof request.signal !== 'object') throw new TypeError('Ubuntu installer-layer signal is invalid');
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('Ubuntu installer-layer materialization was interrupted');
    const [xorriso, unsquashfs] = await Promise.all([
      directTool(this.xorriso, 'xorriso executable'),
      directTool(this.unsquashfs, 'unsquashfs executable'),
    ]);
    const layersRoot = path.join(destination, 'installer-layers');
    await mkdir(layersRoot);
    const layers = [];
    for (const name of names) {
      const location = path.join(layersRoot, `${name}.squashfs`);
      const result = await this.run(xorriso, [
        '-osirrox', 'on', '-indev', media, '-extract', `/casper/${name}.squashfs`, location,
      ], { signal: request.signal ?? null, maximumStdout: MAX_TOOL_OUTPUT_BYTES });
      if (!result || result.code !== 0 || result.signal != null || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr)) {
        fail(toolFailure(`Ubuntu installer layer ${name} extraction`, result ?? { stderr: Buffer.alloc(0) }));
      }
      const info = await lstat(location, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 1n || info.size > BigInt(request.mediaBytes)) {
        fail(`Ubuntu installer layer ${name} extraction returned invalid output`);
      }
      layers.push(Object.freeze({ name, location }));
    }
    const [status, keyring] = await Promise.all([
      selectEntry({
        layers, entry: 'var/lib/dpkg/status', context: 'Ubuntu installer dpkg status', maximum: MAX_STATUS_BYTES,
        run: this.run, executable: unsquashfs, signal: request.signal ?? null,
      }),
      selectEntry({
        layers, entry: 'usr/share/keyrings/ubuntu-archive-keyring.gpg', context: 'Ubuntu installer archive keyring',
        maximum: MAX_KEYRING_BYTES, run: this.run, executable: unsquashfs, signal: request.signal ?? null,
      }),
    ]);
    const statusFile = path.join(destination, 'status');
    const keyringFile = path.join(destination, 'ubuntu-archive-keyring.gpg');
    await Promise.all([
      writeFile(statusFile, status.bytes, { flag: 'wx', mode: 0o600 }),
      writeFile(keyringFile, keyring.bytes, { flag: 'wx', mode: 0o600 }),
    ]);
    return Object.freeze({
      statusFile,
      statusLayer: status.layer,
      keyringFile,
      keyringLayer: keyring.layer,
      layers: names,
      layerFiles: Object.freeze(layers),
    });
  }
}
