import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createEnvironmentConstructionPipeline } from '../app/environment-construction.js';
import { createEnvironmentLifecycle } from '../app/environment-lifecycle.js';
import { createEnvironmentLifecycleFence } from '../app/environment-lifecycle-fence.js';
import { createEnvironmentOperator } from '../app/environment-operator.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { ENVIRONMENT_DECLARATION_PROTOCOL, logicalEnvironmentIdentity } from '../runtime/environment-declaration.js';
import { EnvironmentCreate } from '../runtime/environment-create.js';
import { EnvironmentRecreate } from '../runtime/environment-recreate.js';
import { ENVIRONMENT_OBSERVATION_PROTOCOL } from '../runtime/environment-observation.js';
import { createLifecycleAuthoritySocketExchange } from '../runtime/environment-lifecycle-authority-transport.js';

const REQUEST_PROTOCOL = 'devbridge/windows-lifecycle-authority-acceptance-request-v1';
const RESULT_PROTOCOL = 'devbridge/windows-lifecycle-authority-acceptance-result-v1';
const FIXTURE_PROTOCOL = 'devbridge/windows-lifecycle-authority-acceptance-fixture-v1';
const PROFILE = 'windows-lifecycle-authority-acceptance-v1';
const FIXTURE_BYTES = 16 * 1024 * 1024;
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
]);
const SAFE_GENERATION = /^acceptance-[0-9a-f]{32}$/u;
const DENIED_CODES = new Set(['EACCES', 'EPERM']);
const OPERATIONS = new Set(['exercise', 'cleanup']);

const ENSURE_VHDX_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
if (-not (Test-Path -LiteralPath ([string]$data.path) -PathType Leaf)) {
  $null = New-VHD -Path ([string]$data.path) -Dynamic -SizeBytes ([long]$data.sizeBytes) -ErrorAction Stop
}
if (-not (Test-VHD -Path ([string]$data.path) -ErrorAction Stop)) { throw 'acceptance VHDX is unusable' }
$disk = Get-VHD -Path ([string]$data.path) -ErrorAction Stop
$parent = if ([string]::IsNullOrWhiteSpace([string]$disk.ParentPath)) { $null } else { [string]$disk.ParentPath }
if ([string]$disk.VhdFormat -ne 'VHDX' -or [string]$disk.VhdType -ne 'Dynamic' -or [long]$disk.Size -ne [long]$data.sizeBytes -or $null -ne $parent) {
  throw 'acceptance VHDX shape mismatch'
}
@{
  ready = $true
  diskIdentity = if ($null -eq $disk.DiskIdentifier) { $null } else { ([string]$disk.DiskIdentifier).ToLowerInvariant() }
} | ConvertTo-Json -Compress
`;

const INSPECT_VHDX_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
if (-not (Test-Path -LiteralPath ([string]$data.path) -PathType Leaf)) {
  @{ exists = $false; ready = $false; diskIdentity = $null } | ConvertTo-Json -Compress
  exit 0
}
if (-not (Test-VHD -Path ([string]$data.path) -ErrorAction Stop)) {
  @{ exists = $true; ready = $false; diskIdentity = $null } | ConvertTo-Json -Compress
  exit 0
}
$disk = Get-VHD -Path ([string]$data.path) -ErrorAction Stop
$parent = if ([string]::IsNullOrWhiteSpace([string]$disk.ParentPath)) { $null } else { [string]$disk.ParentPath }
$ready = [string]$disk.VhdFormat -eq 'VHDX' -and [string]$disk.VhdType -eq 'Dynamic' -and [long]$disk.Size -eq [long]$data.sizeBytes -and $null -eq $parent
@{
  exists = $true
  ready = [bool]$ready
  diskIdentity = if ($null -eq $disk.DiskIdentifier) { $null } else { ([string]$disk.DiskIdentifier).ToLowerInvariant() }
} | ConvertTo-Json -Compress
`;

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function invocationSucceeded(result) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.aborted !== true && result?.outputTruncated !== true;
}

function parseBoundedJson(result, message) {
  if (!invocationSucceeded(result)) throw new Error(message);
  try {
    const value = JSON.parse(String(result.stdout ?? '').trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch {
    throw new Error(message);
  }
}

function requireDirectory(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is required`);
  return path.resolve(value);
}

function generationFor(operationId) {
  if (typeof operationId !== 'string' || operationId.length === 0 || operationId.includes('\0')) throw new TypeError('acceptance operation identity is invalid');
  return `acceptance-${createHash('sha256').update('devbridge/windows-lifecycle-authority-acceptance-generation-v1\0').update(operationId).digest('hex').slice(0, 32)}`;
}

function fileIdentity(info) {
  return Object.freeze({
    device: String(info.dev),
    inode: String(info.ino),
    createdNs: String(info.birthtimeNs ?? 0n),
  });
}

function sameFileIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode && left?.createdNs === right?.createdNs;
}

function emptyFixtureState() {
  return { protocol: FIXTURE_PROTOCOL, currentGeneration: null, generations: {} };
}

function validateGenerationRecord(generation, raw) {
  if (!SAFE_GENERATION.test(generation) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('acceptance fixture state is invalid');
  for (const key of Object.keys(raw)) {
    if (!['phase', 'fileName', 'diskIdentity', 'fileIdentity'].includes(key)) throw new Error('acceptance fixture state is invalid');
  }
  if (!['planned', 'ready'].includes(raw.phase)) throw new Error('acceptance fixture state is invalid');
  if (raw.fileName !== `${generation}.vhdx`) throw new Error('acceptance fixture state is invalid');
  if (raw.diskIdentity != null && (typeof raw.diskIdentity !== 'string' || raw.diskIdentity.length === 0 || raw.diskIdentity.includes('\0'))) throw new Error('acceptance fixture state is invalid');
  if (raw.fileIdentity != null) {
    for (const key of ['device', 'inode', 'createdNs']) if (typeof raw.fileIdentity?.[key] !== 'string') throw new Error('acceptance fixture state is invalid');
  }
  return raw;
}

function validateFixtureState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.protocol !== FIXTURE_PROTOCOL) throw new Error('acceptance fixture state is invalid');
  for (const key of Object.keys(raw)) if (!['protocol', 'currentGeneration', 'generations'].includes(key)) throw new Error('acceptance fixture state is invalid');
  if (!raw.generations || typeof raw.generations !== 'object' || Array.isArray(raw.generations)) throw new Error('acceptance fixture state is invalid');
  if (raw.currentGeneration != null && !SAFE_GENERATION.test(raw.currentGeneration)) throw new Error('acceptance fixture state is invalid');
  for (const [generation, record] of Object.entries(raw.generations)) validateGenerationRecord(generation, record);
  if (raw.currentGeneration != null && !raw.generations[raw.currentGeneration]) throw new Error('acceptance fixture state is invalid');
  return raw;
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

export class WindowsLifecycleAuthorityAcceptanceFixture {
  #root;
  #generations;
  #manifest;
  #invoke;
  #environment;

  constructor({ root, invoke = invokeCommand, environment = process.env } = {}) {
    this.#root = requireDirectory(root, 'Windows lifecycle authority acceptance root');
    if (typeof invoke !== 'function') throw new TypeError('Windows lifecycle authority acceptance invocation contract is invalid');
    this.#generations = path.join(this.#root, 'generations');
    this.#manifest = path.join(this.#root, 'fixture.json');
    this.#invoke = invoke;
    this.#environment = environment;
  }

  get root() { return this.#root; }

  diskPath(generation) {
    if (!SAFE_GENERATION.test(generation)) throw new TypeError('Windows lifecycle authority acceptance generation is invalid');
    return path.join(this.#generations, `${generation}.vhdx`);
  }

  async #ensureRoot() {
    await mkdir(this.#generations, { recursive: true, mode: 0o700 });
    for (const directory of [this.#root, this.#generations]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Windows lifecycle authority acceptance root must be a real directory');
    }
  }

  async #load() {
    await this.#ensureRoot();
    try {
      const info = await lstat(this.#manifest);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('acceptance fixture state must be a real file');
      return validateFixtureState(JSON.parse(await readFile(this.#manifest, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyFixtureState();
      throw error;
    }
  }

  async #save(state) {
    validateFixtureState(state);
    await this.#ensureRoot();
    await writeJsonAtomic(this.#manifest, state);
  }

  async #inspectDisk(generation, record) {
    const diskPath = this.diskPath(generation);
    let info;
    try { info = await lstat(diskPath, { bigint: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ exists: false, ready: false, generation, diskPath });
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) return Object.freeze({ exists: true, ready: false, generation, diskPath });
    if (record?.fileIdentity && !sameFileIdentity(record.fileIdentity, fileIdentity(info))) return Object.freeze({ exists: true, ready: false, generation, diskPath });
    const result = parseBoundedJson(await this.#invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(INSPECT_VHDX_SCRIPT)],
      input: JSON.stringify({ path: diskPath, sizeBytes: FIXTURE_BYTES }),
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      environment: this.#environment,
    }), 'Windows lifecycle authority acceptance VHDX inspection failed');
    if (typeof result.exists !== 'boolean' || typeof result.ready !== 'boolean' || (result.diskIdentity != null && typeof result.diskIdentity !== 'string')) {
      throw new Error('Windows lifecycle authority acceptance VHDX inspection returned invalid evidence');
    }
    if (result.exists !== true || result.ready !== true) return Object.freeze({ exists: result.exists === true, ready: false, generation, diskPath });
    if (record?.diskIdentity != null && result.diskIdentity !== record.diskIdentity) return Object.freeze({ exists: true, ready: false, generation, diskPath });
    return Object.freeze({ exists: true, ready: true, generation, diskPath, diskIdentity: result.diskIdentity, fileIdentity: fileIdentity(info) });
  }

  async observe() {
    const state = await this.#load();
    if (state.currentGeneration == null) return Object.freeze({ state: 'absent', generation: null, diskPath: null });
    const generation = state.currentGeneration;
    const record = validateGenerationRecord(generation, state.generations[generation]);
    const observed = await this.#inspectDisk(generation, record);
    if (!observed.exists) return Object.freeze({ state: 'missing', generation, diskPath: observed.diskPath });
    if (!observed.ready || record.phase !== 'ready') return Object.freeze({ state: 'invalid', generation, diskPath: observed.diskPath });
    return Object.freeze({ state: 'ready', generation, diskPath: observed.diskPath });
  }

  async ensure({ operationId } = {}) {
    const generation = generationFor(operationId);
    const state = await this.#load();
    let record = state.generations[generation] ?? null;
    if (record == null) {
      record = { phase: 'planned', fileName: `${generation}.vhdx`, diskIdentity: null, fileIdentity: null };
      state.generations[generation] = record;
      await this.#save(state);
    } else {
      validateGenerationRecord(generation, record);
    }

    let observed = await this.#inspectDisk(generation, record);
    if (!observed.exists) {
      const result = parseBoundedJson(await this.#invoke({
        executable: POWERSHELL,
        arguments: [...POWERSHELL_ARGS, encodedScript(ENSURE_VHDX_SCRIPT)],
        input: JSON.stringify({ path: observed.diskPath, sizeBytes: FIXTURE_BYTES }),
        timeoutMs: 60_000,
        maxOutputBytes: 64 * 1024,
        environment: this.#environment,
      }), 'Windows lifecycle authority acceptance VHDX creation failed');
      if (result.ready !== true || (result.diskIdentity != null && typeof result.diskIdentity !== 'string')) throw new Error('Windows lifecycle authority acceptance VHDX creation returned invalid evidence');
      observed = await this.#inspectDisk(generation, null);
    }
    if (!observed.ready) throw new Error('Windows lifecycle authority acceptance VHDX did not verify');

    state.generations[generation] = {
      phase: 'ready',
      fileName: `${generation}.vhdx`,
      diskIdentity: observed.diskIdentity ?? null,
      fileIdentity: observed.fileIdentity,
    };
    state.currentGeneration = generation;
    await this.#save(state);
    return Object.freeze({ ready: true, implementationGeneration: generation });
  }

  async retire({ previousImplementationGeneration, implementationGeneration } = {}) {
    if (!SAFE_GENERATION.test(previousImplementationGeneration) || !SAFE_GENERATION.test(implementationGeneration) || previousImplementationGeneration === implementationGeneration) {
      throw new TypeError('Windows lifecycle authority acceptance retirement generation is invalid');
    }
    const state = await this.#load();
    if (state.currentGeneration !== implementationGeneration) throw new Error('Windows lifecycle authority acceptance retirement current generation changed');
    const record = state.generations[previousImplementationGeneration];
    if (!record) return Object.freeze({ ready: true, retired: false });
    validateGenerationRecord(previousImplementationGeneration, record);
    const observed = await this.#inspectDisk(previousImplementationGeneration, record);
    if (observed.exists && !observed.ready) throw new Error('Windows lifecycle authority acceptance retirement refused mismatched VHDX');
    if (observed.exists) await rm(observed.diskPath, { force: false });
    delete state.generations[previousImplementationGeneration];
    await this.#save(state);
    return Object.freeze({ ready: true, retired: observed.exists });
  }

  async clear() {
    const state = await this.#load();
    for (const [generation, raw] of Object.entries(state.generations)) {
      const record = validateGenerationRecord(generation, raw);
      const observed = await this.#inspectDisk(generation, record);
      const probe = `${this.diskPath(generation)}.ordinary-replace-probe`;
      if (observed.exists && !observed.ready) throw new Error('Windows lifecycle authority acceptance cleanup refused mismatched VHDX');
      if (observed.exists) await rm(observed.diskPath, { force: false });
      let probeInfo = null;
      try { probeInfo = await lstat(probe, { bigint: true }); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (probeInfo) {
        if (!probeInfo.isFile() || probeInfo.isSymbolicLink() || !record.fileIdentity || !sameFileIdentity(record.fileIdentity, fileIdentity(probeInfo))) {
          throw new Error('Windows lifecycle authority acceptance cleanup refused mismatched probe file');
        }
        await rm(probe, { force: false });
      }
    }
    await rm(this.#manifest, { force: true });
    return Object.freeze({ cleaned: true });
  }
}

function acceptanceDeclaration() {
  return Object.freeze({
    protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
    profile: PROFILE,
    schemaGeneration: 'acceptance-v1',
    guest: Object.freeze({ family: 'acceptance', generation: 'acceptance-v1' }),
    image: Object.freeze({ identity: 'acceptance-vhdx', generation: 'acceptance-v1' }),
    resources: Object.freeze({ memoryBytes: 256 * 1024 * 1024, processorCount: 1 }),
    boot: Object.freeze({ requirement: 'none' }),
    network: Object.freeze({ requirement: 'none' }),
    bootstrap: Object.freeze({ generation: 'acceptance-v1', requirements: Object.freeze([]) }),
    enrollment: Object.freeze({ requirement: 'none' }),
    workspaces: Object.freeze([]),
    protectedStateClasses: Object.freeze([]),
  });
}

function observationFor(record, fixture) {
  const base = {
    protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
    environmentIdentity: record.identity,
    declarationRevision: record.revision,
    implementationGeneration: fixture.generation,
    transition: 'clear',
  };
  if (fixture.state === 'absent') {
    return Object.freeze({ ...base, implementationGeneration: null, materialization: 'none', systemStorage: 'absent', attachment: 'unknown', enrollment: 'unknown', bootstrap: 'unknown', guest: 'unknown' });
  }
  if (fixture.state === 'missing') {
    return Object.freeze({ ...base, materialization: 'missing', systemStorage: 'absent', attachment: 'invalid', enrollment: 'unknown', bootstrap: 'unknown', guest: 'unknown' });
  }
  if (fixture.state === 'invalid') {
    return Object.freeze({ ...base, materialization: 'present', systemStorage: 'invalid', attachment: 'invalid', enrollment: 'unknown', bootstrap: 'unknown', guest: 'unknown' });
  }
  return Object.freeze({ ...base, materialization: 'present', systemStorage: 'present', attachment: 'ready', enrollment: 'ready', bootstrap: 'ready', guest: 'healthy' });
}

function exactAuthorization() {
  return Object.freeze({ async verify({ approval, subject }) { return Object.freeze({ approved: approval === subject, subject }); } });
}

function acceptancePort(ensure) {
  return Object.freeze({ ensure });
}

export async function createWindowsLifecycleAuthorityAcceptanceOperator({
  root,
  fixture = null,
  invoke = invokeCommand,
  environment = process.env,
  fence = null,
} = {}) {
  const selectedRoot = requireDirectory(root, 'Windows lifecycle authority acceptance operator root');
  const selectedFixture = fixture ?? new WindowsLifecycleAuthorityAcceptanceFixture({ root: path.join(selectedRoot, 'fixture'), invoke, environment });
  if (!selectedFixture || typeof selectedFixture.observe !== 'function' || typeof selectedFixture.ensure !== 'function' || typeof selectedFixture.retire !== 'function') {
    throw new TypeError('Windows lifecycle authority acceptance fixture contract is incomplete');
  }
  const lifecycle = createEnvironmentLifecycle({ stateDirectory: selectedRoot });
  const registration = await lifecycle.declarations.register(acceptanceDeclaration());
  const record = registration.record;
  const observer = Object.freeze({ async observe() { return observationFor(record, await selectedFixture.observe()); } });
  const lifecycleFence = fence ?? createEnvironmentLifecycleFence({ stateDirectory: selectedRoot });
  const image = acceptancePort(async () => Object.freeze({ ready: true }));
  const resources = acceptancePort(async () => Object.freeze({ ready: true }));
  const materialization = acceptancePort(async (request) => selectedFixture.ensure({ operationId: request.operationId }));
  const continuation = acceptancePort(async (request) => Object.freeze({ ready: true, implementationGeneration: request.implementationGeneration }));
  const readiness = Object.freeze({
    async verify() {
      const observed = observationFor(record, await selectedFixture.observe());
      if (observed.materialization !== 'present' || observed.systemStorage !== 'present') throw new Error('Windows lifecycle authority acceptance fixture is not ready');
      return Object.freeze({ ready: true, implementationGeneration: observed.implementationGeneration, observation: observed });
    },
  });
  const construction = createEnvironmentConstructionPipeline({
    stateDirectory: selectedRoot,
    image,
    resources,
    materialization,
    preparation: continuation,
    workspaces: continuation,
    readiness,
  });
  const creation = new EnvironmentCreate({ declarations: lifecycle.declarations, journal: lifecycle.journal, observer, fence: lifecycleFence, construction });
  const recreate = new EnvironmentRecreate({
    declarations: lifecycle.declarations,
    journal: lifecycle.journal,
    observer,
    fence: lifecycleFence,
    construction,
    retirement: Object.freeze({ ensure: (request) => selectedFixture.retire(request) }),
    evidence: Object.freeze({ async inspect() { return Object.freeze({ resources: 'ready', network: 'ready', workspaces: 'ready' }); } }),
    authorization: exactAuthorization(),
  });
  const runtime = Object.freeze({
    lifecycle,
    observer,
    async diagnose() { return Object.freeze({ state: 'ready', cause: 'healthy', repairableInPlace: false, supportedNextAction: 'none', explanation: 'acceptance fixture ready', impact: Object.freeze({ destructive: false, preserves: Object.freeze([]), unavailable: Object.freeze([]), reseedable: Object.freeze([]) }) }); },
    create: (identity) => creation.create(identity),
    planRecreate: (identity) => recreate.plan(identity),
    recreate: (identity, options) => recreate.recreate(identity, options),
  });
  return Object.freeze({ operator: createEnvironmentOperator({ runtime }), lifecycle, fixture: selectedFixture, environmentIdentity: record.identity });
}

function active(record) {
  return record != null && record.entries?.at(-1)?.stage !== 'terminal';
}

function stage(record) {
  return record?.entries?.at(-1)?.stage ?? null;
}

async function exerciseAcceptance({ operator, lifecycle, fixture, environmentIdentity }) {
  let current = await lifecycle.journal.current(environmentIdentity);
  if (active(current) && current.operation === 'create') {
    await operator.run('create', environmentIdentity);
  } else {
    const observed = await fixture.observe();
    if (observed.state === 'absent') await operator.run('create', environmentIdentity);
  }

  current = await lifecycle.journal.current(environmentIdentity);
  if (active(current) && current.operation === 'recreate') {
    if (stage(current) === 'intent') {
      const impact = await operator.plan('recreate', environmentIdentity);
      await operator.run('recreate', environmentIdentity, { approval: impact.authorizationSubject });
    } else {
      await operator.run('recreate', environmentIdentity, { approval: null });
    }
  } else {
    const impact = await operator.plan('recreate', environmentIdentity);
    if (impact.blocked === true || !impact.authorizationSubject) throw new Error('Windows lifecycle authority acceptance recreate impact is blocked');
    await operator.run('recreate', environmentIdentity, { approval: impact.authorizationSubject });
  }

  const final = await fixture.observe();
  if (final.state !== 'ready' || !SAFE_GENERATION.test(final.generation)) throw new Error('Windows lifecycle authority acceptance fixture did not finish ready');
  return Object.freeze({ ready: true, generation: final.generation });
}

function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Windows lifecycle authority acceptance request is invalid');
  for (const key of Object.keys(raw)) if (!['protocol', 'requestId', 'operation'].includes(key)) throw new TypeError('Windows lifecycle authority acceptance request is invalid');
  if (raw.protocol !== REQUEST_PROTOCOL || typeof raw.requestId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(raw.requestId) || !OPERATIONS.has(raw.operation)) {
    throw new TypeError('Windows lifecycle authority acceptance request is invalid');
  }
  return Object.freeze({ protocol: REQUEST_PROTOCOL, requestId: raw.requestId, operation: raw.operation });
}

function result(requestId, value) {
  return Object.freeze({ protocol: RESULT_PROTOCOL, requestId, ok: true, value: Object.freeze(value) });
}

function failure(requestId) {
  return Object.freeze({ protocol: RESULT_PROTOCOL, requestId, ok: false, error: Object.freeze({ code: 'ACCEPTANCE_FAILED', message: 'Windows lifecycle authority acceptance operation failed' }) });
}

export async function handleWindowsLifecycleAuthorityAcceptanceRequest({
  request,
  authorityDirectory,
  invoke = invokeCommand,
  environment = process.env,
} = {}, {
  operatorFactory = createWindowsLifecycleAuthorityAcceptanceOperator,
} = {}) {
  let selected;
  try { selected = normalizeRequest(request); }
  catch {
    const requestId = typeof request?.requestId === 'string' && /^[0-9a-f-]{36}$/iu.test(request.requestId) ? request.requestId : randomUUID();
    return failure(requestId);
  }
  const root = path.join(requireDirectory(authorityDirectory, 'Windows lifecycle authority acceptance authorityDirectory'), 'acceptance');
  try {
    const composition = await operatorFactory({ root, invoke, environment });
    if (selected.operation === 'exercise') return result(selected.requestId, await exerciseAcceptance(composition));
    await composition.fixture.clear();
    await rm(path.join(root, 'environment-lifecycle', 'state.json'), { force: true });
    await rm(path.join(root, 'environment-construction', 'state.json'), { force: true });
    return result(selected.requestId, { cleaned: true });
  } catch {
    return failure(selected.requestId);
  }
}

function normalizeResponse(raw, requestId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.protocol !== RESULT_PROTOCOL || raw.requestId !== requestId || typeof raw.ok !== 'boolean') {
    throw new Error('Windows lifecycle authority acceptance returned invalid bounded status');
  }
  if (raw.ok !== true) throw new Error('Windows lifecycle authority acceptance operation failed');
  if (!raw.value || typeof raw.value !== 'object' || Array.isArray(raw.value)) throw new Error('Windows lifecycle authority acceptance returned invalid bounded status');
  return raw.value;
}

export function createWindowsLifecycleAuthorityAcceptanceClient({ endpoint, connectTimeoutMs = 3_000 } = {}, {
  exchangeFactory = createLifecycleAuthoritySocketExchange,
} = {}) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.includes('\0')) throw new TypeError('Windows lifecycle authority acceptance endpoint is required');
  if (typeof exchangeFactory !== 'function') throw new TypeError('Windows lifecycle authority acceptance exchange factory is invalid');
  const exchange = exchangeFactory({ endpoint, connectTimeoutMs });
  if (typeof exchange !== 'function') throw new TypeError('Windows lifecycle authority acceptance exchange is invalid');
  const request = async (operation) => {
    const requestId = randomUUID();
    const value = normalizeResponse(await exchange({ protocol: REQUEST_PROTOCOL, requestId, operation }), requestId);
    if (operation === 'exercise') {
      if (value.ready !== true || !SAFE_GENERATION.test(value.generation) || Object.keys(value).some((key) => !['ready', 'generation'].includes(key))) {
        throw new Error('Windows lifecycle authority acceptance returned invalid bounded status');
      }
      return Object.freeze({ ready: true, generation: value.generation });
    }
    if (value.cleaned !== true || Object.keys(value).some((key) => key !== 'cleaned')) throw new Error('Windows lifecycle authority acceptance returned invalid bounded status');
    return Object.freeze({ cleaned: true });
  };
  return Object.freeze({ exercise: () => request('exercise'), cleanup: () => request('cleanup') });
}

export function windowsLifecycleAuthorityAcceptanceDiskPath({ authorityDirectory, generation } = {}) {
  if (typeof authorityDirectory !== 'string' || authorityDirectory.length === 0 || authorityDirectory.includes('\0')) throw new TypeError('Windows lifecycle authority acceptance authorityDirectory is required');
  if (!SAFE_GENERATION.test(generation)) throw new TypeError('Windows lifecycle authority acceptance generation is invalid');
  const localPath = process.platform === 'win32' ? path.win32 : path;
  return localPath.join(authorityDirectory, 'acceptance', 'fixture', 'generations', `${generation}.vhdx`);
}

async function expectDenied(action, message) {
  try { await action(); }
  catch (error) {
    if (DENIED_CODES.has(error?.code)) return;
    throw new Error(message);
  }
  throw new Error(message);
}

export async function proveWindowsLifecycleAuthorityAcceptanceDirectMutationDenied(diskPath, {
  renameFile = rename,
  unlinkFile = unlink,
} = {}) {
  if (typeof diskPath !== 'string' || diskPath.length === 0 || diskPath.includes('\0')) throw new TypeError('Windows lifecycle authority acceptance disk path is invalid');
  const probe = `${diskPath}.ordinary-replace-probe`;
  await expectDenied(async () => {
    await renameFile(diskPath, probe);
    try { await renameFile(probe, diskPath); } catch {}
  }, 'Windows lifecycle authority acceptance backing-disk replacement was not denied to the ordinary identity');
  await expectDenied(() => unlinkFile(diskPath), 'Windows lifecycle authority acceptance backing-disk deletion was not denied to the ordinary identity');
  return Object.freeze({ ready: true });
}

export async function verifyWindowsLifecycleAuthorityAcceptance({
  authorityDirectory,
  endpoint,
} = {}, {
  clientFactory = createWindowsLifecycleAuthorityAcceptanceClient,
  directMutationDenied = proveWindowsLifecycleAuthorityAcceptanceDirectMutationDenied,
  diskPathFor = windowsLifecycleAuthorityAcceptanceDiskPath,
} = {}) {
  if (typeof clientFactory !== 'function' || typeof directMutationDenied !== 'function' || typeof diskPathFor !== 'function') {
    throw new TypeError('Windows lifecycle authority acceptance verification composition is invalid');
  }
  const client = clientFactory({ endpoint });
  let exercise = null;
  let failureValue = null;
  try {
    exercise = await client.exercise();
    const diskPath = diskPathFor({ authorityDirectory, generation: exercise.generation });
    await directMutationDenied(diskPath);
    return Object.freeze({ protocol: RESULT_PROTOCOL, ready: true, generation: exercise.generation });
  } catch (error) {
    failureValue = error;
    throw error;
  } finally {
    if (exercise != null || failureValue != null) {
      try { await client.cleanup(); }
      catch {
        if (failureValue == null) throw new Error('Windows lifecycle authority acceptance cleanup failed');
      }
    }
  }
}

export {
  REQUEST_PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_REQUEST_PROTOCOL,
  RESULT_PROTOCOL as WINDOWS_LIFECYCLE_AUTHORITY_ACCEPTANCE_RESULT_PROTOCOL,
};
