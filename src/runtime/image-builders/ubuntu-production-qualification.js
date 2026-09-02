import { createHash } from 'node:crypto';

const BRIDGE_PROTOCOL = 'devbridge/environment-bridge-v1';
const PROTOCOL = 'devbridge/ubuntu-production-qualification-v1';
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PAYLOAD_PATH = /^\/usr\/local\/libexec\/devbridge\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,79}$/u;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,159}$/u;
const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const MUTABLE_VERSION = /^(?:latest|stable|current|head|main|master)$/iu;
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,122}\.service$/u;
const DEFAULT_POLL_MS = 250;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function packageVersion(value, name) {
  if (typeof value !== 'string' || !PACKAGE_VERSION.test(value) || !/\d/u.test(value) || MUTABLE_VERSION.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeExpected(raw) {
  const value = onlyKeys(raw, new Set(['payloadGeneration', 'files', 'packageGeneration', 'packageSnapshot', 'packages', 'commands', 'services']), 'qualification expected state');
  if (typeof value.payloadGeneration !== 'string' || !GENERATION.test(value.payloadGeneration)) throw new TypeError('qualification payload generation is invalid');
  if (typeof value.packageGeneration !== 'string' || !GENERATION.test(value.packageGeneration)) throw new TypeError('qualification package generation is invalid');
  if (typeof value.packageSnapshot !== 'string' || !SNAPSHOT.test(value.packageSnapshot)) throw new TypeError('qualification package snapshot is invalid');
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 32) throw new TypeError('qualification expected file set is invalid');
  if (!Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 64) throw new TypeError('qualification expected package set is invalid');
  if (!Array.isArray(value.commands) || value.commands.length > 32) throw new TypeError('qualification expected command set is invalid');
  const fileNames = new Set();
  const files = value.files.map((entry, index) => {
    const file = onlyKeys(entry, new Set(['path', 'sha256']), `qualification expected file ${index}`);
    if (typeof file.path !== 'string' || !PAYLOAD_PATH.test(file.path) || fileNames.has(file.path)) throw new TypeError(`qualification expected file ${index}.path is invalid`);
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw new TypeError(`qualification expected file ${index}.sha256 is invalid`);
    fileNames.add(file.path);
    return Object.freeze({ path: file.path, sha256: file.sha256 });
  });
  const packageNames = new Set();
  const packages = value.packages.map((entry, index) => {
    const item = onlyKeys(entry, new Set(['name', 'version']), `qualification expected package ${index}`);
    if (typeof item.name !== 'string' || !PACKAGE_NAME.test(item.name) || packageNames.has(item.name)) throw new TypeError(`qualification expected package ${index}.name is invalid`);
    const version = packageVersion(item.version, `qualification expected package ${index}.version`);
    packageNames.add(item.name);
    return Object.freeze({ name: item.name, version });
  });
  const commands = [];
  const commandNames = new Set();
  for (const [index, entry] of value.commands.entries()) {
    if (typeof entry !== 'string' || !COMMAND.test(entry) || commandNames.has(entry)) throw new TypeError(`qualification expected command ${index} is invalid`);
    commandNames.add(entry);
    commands.push(entry);
  }
  const services = [];
  const serviceNames = new Set();
  const serviceSource = value.services ?? [];
  if (!Array.isArray(serviceSource) || serviceSource.length > 16) throw new TypeError('qualification expected service set is invalid');
  for (const [index, entry] of serviceSource.entries()) {
    if (typeof entry !== 'string' || !SERVICE.test(entry) || serviceNames.has(entry)) throw new TypeError(`qualification expected service ${index} is invalid`);
    serviceNames.add(entry);
    services.push(entry);
  }
  return Object.freeze({ payloadGeneration: value.payloadGeneration, files, packageGeneration: value.packageGeneration, packageSnapshot: value.packageSnapshot, packages, commands, services });
}

function requestId(target, phase, body) {
  return createHash('sha256').update(`${target}:${phase}:${JSON.stringify(body)}`, 'utf8').digest('hex').slice(0, 32);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function qualificationScript(expected) {
  const fileChecks = expected.files.map((file) => `printf '%s  %s\\n' ${shellQuote(file.sha256)} ${shellQuote(file.path)}`).join('\n');
  const packageChecks = expected.packages.map((item) => `[ "$(dpkg-query -W -f='${'$'}{Version}' ${shellQuote(item.name)})" = ${shellQuote(item.version)} ]`).join('\n');
  const packageSpecifications = expected.packages.map((item) => `${item.name}=${item.version}`);
  const serviceCommands = expected.services.length === 0 ? [] : ['systemctl'];
  const commands = [...new Set(['node', 'npm', 'git', 'cmake', 'ctest', 'cc', 'c++', 'curl', 'getent', 'sha256sum', 'dpkg-query', 'apt-get', ...serviceCommands, ...expected.commands])];
  const serviceChecks = expected.services.length === 0 ? '' : `\nfor service in ${expected.services.map(shellQuote).join(' ')}; do\n  systemctl is-enabled --quiet "${'$'}service"\n  systemctl is-active --quiet "${'$'}service"\ndone`;
  return `set -eu\n. /etc/os-release\n[ "${'$'}ID" = ubuntu ]\nfor command in ${commands.map(shellQuote).join(' ')}; do command -v "${'$'}command" >/dev/null 2>&1; done${serviceChecks}\n${packageChecks}\napt-get --snapshot ${shellQuote(expected.packageSnapshot)} --simulate install -y --no-install-recommends ${packageSpecifications.map(shellQuote).join(' ')} >/dev/null\ngetent ahostsv4 example.com >/dev/null\ncurl --fail --silent --show-error --max-time 15 https://example.com/ -o /dev/null\n{\n${fileChecks}\n} | sha256sum -c - >/dev/null\nroot=$(mktemp -d)\ntrap 'rm -rf "${'$'}root"' EXIT HUP INT TERM\ncat >"${'$'}root/CMakeLists.txt" <<'CMAKE'\ncmake_minimum_required(VERSION 3.16)\nproject(devbridge_image_probe C)\nenable_testing()\nadd_executable(probe main.c)\nadd_test(NAME probe COMMAND probe)\nCMAKE\ncat >"${'$'}root/main.c" <<'C'\n#include <stdio.h>\nint main(void) { puts("devbridge-image-probe"); return 0; }\nC\ncmake -S "${'$'}root" -B "${'$'}root/build" >/dev/null\ncmake --build "${'$'}root/build" >/dev/null\nctest --test-dir "${'$'}root/build" --output-on-failure >/dev/null\nprintf 'protocol=${PROTOCOL}\\n'\nprintf 'os=%s\\n' "${'$'}VERSION_ID"\nprintf 'node='; node --version\nprintf 'npm='; npm --version\nprintf 'git='; git --version\nprintf 'cmake='; cmake --version | head -n 1\nprintf 'compiler='; cc --version | head -n 1\nprintf 'payload-generation=${expected.payloadGeneration}\\n'\nprintf 'package-generation=${expected.packageGeneration}\\n'\nprintf 'package-snapshot=${expected.packageSnapshot}\\n'\nprintf 'network=ready\\n'\nprintf 'cmake-ctest=passed\\n'\n`;
}

function operationBody(script, timeoutMs) {
  return {
    program: 'sh',
    arguments: ['-c', script],
    directory: { class: 'scratch', path: '.' },
    environment: { LC_ALL: 'C', LANG: 'C' },
    input: null,
    timeoutMs,
    maxOutputBytes: 1024 * 1024,
  };
}

function bridgeFrame(target, request, kind, body) {
  return { protocol: BRIDGE_PROTOCOL, request, target, kind, body };
}

function validateResponse(raw, target, request, kind) {
  const value = onlyKeys(raw, new Set(['protocol', 'request', 'target', 'kind', 'ok', 'body', 'error']), 'qualification bridge response');
  if (value.protocol !== BRIDGE_PROTOCOL || value.request !== request || value.target !== target || value.kind !== kind) throw new Error('qualification bridge response identity changed');
  if (value.ok !== true) throw new Error(String(value.error?.message ?? 'qualification bridge operation failed').slice(0, 2048));
  return onlyKeys(value.body, new Set(['state', 'result', 'reason']), 'qualification bridge response body');
}

function decodeResult(raw) {
  const value = onlyKeys(raw, new Set(['exitCode', 'signal', 'timedOut', 'aborted', 'outputTruncated', 'stdout', 'stderr', 'startedAt', 'finishedAt', 'lastOutputAt']), 'qualification bridge result');
  const decode = (text, name) => {
    if (typeof text !== 'string') throw new Error(`${name} is invalid`);
    const bytes = Buffer.from(text, 'base64');
    if (bytes.toString('base64') !== text) throw new Error(`${name} is not canonical base64`);
    return bytes.toString('utf8');
  };
  return {
    exitCode: value.exitCode,
    timedOut: value.timedOut === true,
    aborted: value.aborted === true,
    outputTruncated: value.outputTruncated === true,
    stdout: decode(value.stdout, 'qualification stdout'),
    stderr: decode(value.stderr, 'qualification stderr'),
  };
}

function parseEvidence(stdout, expectedProtocol) {
  const result = {};
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line) continue;
    const split = line.indexOf('=');
    if (split <= 0) throw new Error('qualification output is not structured evidence');
    const key = line.slice(0, split);
    const value = line.slice(split + 1);
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(key) || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1024 || Object.hasOwn(result, key)) throw new Error('qualification output evidence is invalid');
    result[key] = value;
  }
  if (result.protocol !== expectedProtocol) throw new Error('qualification output protocol is invalid');
  return result;
}

function qualificationEvidence(qualified, selected, sanitized) {
  return Object.freeze({
    protocol: PROTOCOL,
    os: qualified.os,
    node: qualified.node,
    npm: qualified.npm,
    git: qualified.git,
    cmake: qualified.cmake,
    compiler: qualified.compiler,
    payloadGeneration: selected.payloadGeneration,
    packageGeneration: selected.packageGeneration,
    packageSnapshot: selected.packageSnapshot,
    commands: Object.freeze([...selected.commands]),
    services: Object.freeze([...selected.services]),
    network: true,
    cmakeCtest: true,
    sanitized,
  });
}

export class UbuntuProductionImageQualification {
  #bridge;
  #finalizer;
  #sleep;
  #pollMs;

  constructor({ bridge, finalizer, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), pollMs = DEFAULT_POLL_MS } = {}) {
    if (!bridge || typeof bridge.exchange !== 'function') throw new TypeError('qualification bridge must expose exchange');
    if (!finalizer || typeof finalizer.finalize !== 'function') throw new TypeError('qualification finalizer must expose finalize');
    if (typeof sleep !== 'function') throw new TypeError('qualification sleep must be a function');
    if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 5000) throw new TypeError('qualification poll interval is invalid');
    this.#bridge = bridge;
    this.#finalizer = finalizer;
    this.#sleep = sleep;
    this.#pollMs = pollMs;
  }

  async #run(target, body) {
    const request = requestId(target, 'qualification', body);
    let observed = validateResponse(await this.#bridge.exchange(bridgeFrame(target, request, 'execute', body)), target, request, 'execute');
    const deadline = Date.now() + body.timeoutMs + 30_000;
    while (!['completed', 'failed'].includes(observed.state)) {
      if (!['planned', 'running', 'indeterminate'].includes(observed.state)) throw new Error(`qualification bridge state is invalid: ${observed.state}`);
      if (Date.now() >= deadline) throw new Error('qualification bridge observation deadline expired');
      await this.#sleep(this.#pollMs);
      observed = validateResponse(await this.#bridge.exchange(bridgeFrame(target, request, 'observe', {})), target, request, 'observe');
    }
    if (observed.state === 'failed') throw new Error(String(observed.reason ?? 'qualification bridge operation failed').slice(0, 2048));
    const result = decodeResult(observed.result);
    if (result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new Error((result.stderr.trim() || 'qualification operation did not complete successfully').slice(0, 2048));
    return result.stdout;
  }

  async probe({ target, expected }) {
    if (typeof target !== 'string' || !TARGET.test(target)) throw new TypeError('qualification target is invalid');
    const selected = normalizeExpected(expected);
    const qualified = parseEvidence(await this.#run(target, operationBody(qualificationScript(selected), 5 * 60 * 1000)), PROTOCOL);
    if (
      qualified['payload-generation'] !== selected.payloadGeneration
      || qualified['package-generation'] !== selected.packageGeneration
      || qualified['package-snapshot'] !== selected.packageSnapshot
      || qualified.network !== 'ready'
      || qualified['cmake-ctest'] !== 'passed'
    ) throw new Error('qualification evidence does not match the required image contract');
    return qualificationEvidence(qualified, selected, false);
  }

  async finalize(target) {
    if (typeof target !== 'string' || !TARGET.test(target)) throw new TypeError('qualification target is invalid');
    const finalized = await this.#finalizer.finalize(target);
    if (!finalized || finalized.finalized !== true) throw new Error('image finalization did not report completion');
    return Object.freeze({ protocol: finalized.protocol ?? 'devbridge/image-finalization-v1', finalized: true });
  }

  async qualify({ target, expected }) {
    const probed = await this.probe({ target, expected });
    await this.finalize(target);
    return Object.freeze({ ...probed, sanitized: true });
  }
}

export function createUbuntuProductionImageQualification(options) {
  return new UbuntuProductionImageQualification(options);
}
