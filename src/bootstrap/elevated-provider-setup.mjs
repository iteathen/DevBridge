import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEnvironmentFoundation } from '../app/environment-foundation.js';
import { invokeCommand } from '../runtime/command-invocation.js';

const REQUEST_PROTOCOL = 'devbridge/provider-setup-elevation-request-v1';
const RESULT_PROTOCOL = 'devbridge/provider-setup-elevation-result-v1';
const JOURNAL_PROTOCOL = 'devbridge/provider-setup-elevation-journal-v1';
const OPERATION = 'environment-foundation.ensure-network';
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const FOUNDATION_IDENTITY = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESULT_WAIT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 250;
const POWERSHELL = 'powershell.exe';
const COMMAND_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const POWERSHELL_PREAMBLE = "$ProgressPreference = 'SilentlyContinue'\n";
const ELEVATED_SWITCH = '--devbridge-elevated-provider-request';

const ELEVATION_LAUNCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
try {
  $child = Start-Process -FilePath ([string]$data.executable) -ArgumentList ([string]$data.arguments) -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop
  @{ started = $true; pid = [int]$child.Id } | ConvertTo-Json -Compress
} catch {
  @{ started = $false; reason = 'UAC elevation was declined or could not be started'; errorCode = [int]$_.Exception.HResult } | ConvertTo-Json -Compress
}
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function encodeScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function boundedReason(value, fallback = 'provider setup failed') {
  const text = String(value ?? fallback).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
  return (text || fallback).slice(0, 2_048);
}

function closedObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name}.${key} is not allowed`);
  return value;
}

function normalizeRequest(value) {
  const input = closedObject(value, new Set(['protocol', 'requestId', 'operation', 'stateDirectory', 'foundationIdentity', 'requestedAt']), 'elevation request');
  if (input.protocol !== REQUEST_PROTOCOL || input.operation !== OPERATION) throw new Error('elevation request protocol or operation is invalid');
  if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) throw new Error('elevation request identity is invalid');
  if (typeof input.stateDirectory !== 'string' || input.stateDirectory.length === 0 || input.stateDirectory.includes('\0') || Buffer.byteLength(input.stateDirectory, 'utf8') > 4_096) {
    throw new Error('elevation request state directory is invalid');
  }
  if (path.resolve(input.stateDirectory) !== input.stateDirectory) throw new Error('elevation request state directory must be absolute and normalized');
  if (typeof input.foundationIdentity !== 'string' || !FOUNDATION_IDENTITY.test(input.foundationIdentity)) throw new Error('elevation request foundation identity is invalid');
  if (!Number.isFinite(Date.parse(input.requestedAt))) throw new Error('elevation request timestamp is invalid');
  return Object.freeze({
    protocol: REQUEST_PROTOCOL,
    requestId: input.requestId,
    operation: OPERATION,
    stateDirectory: input.stateDirectory,
    foundationIdentity: input.foundationIdentity,
    requestedAt: input.requestedAt,
  });
}

function normalizeResult(value, request, requestSha256) {
  const input = closedObject(value, new Set([
    'protocol', 'requestId', 'requestSha256', 'operation', 'foundationIdentity',
    'status', 'networkingReady', 'completedAt', 'reason',
  ]), 'elevation result');
  if (input.protocol !== RESULT_PROTOCOL || input.operation !== OPERATION) throw new Error('elevation result protocol or operation is invalid');
  if (input.requestId !== request.requestId || input.foundationIdentity !== request.foundationIdentity || input.requestSha256 !== requestSha256) {
    throw new Error('elevation result subject does not match the exact request');
  }
  if (!['succeeded', 'failed'].includes(input.status) || typeof input.networkingReady !== 'boolean') throw new Error('elevation result state is invalid');
  if ((input.status === 'succeeded') !== input.networkingReady) throw new Error('elevation result readiness is inconsistent');
  if (!Number.isFinite(Date.parse(input.completedAt))) throw new Error('elevation result timestamp is invalid');
  const reason = input.reason == null ? null : boundedReason(input.reason);
  if (input.status === 'failed' && !reason) throw new Error('failed elevation result requires a reason');
  return Object.freeze({
    protocol: RESULT_PROTOCOL,
    requestId: request.requestId,
    requestSha256,
    operation: OPERATION,
    foundationIdentity: request.foundationIdentity,
    status: input.status,
    networkingReady: input.networkingReady,
    completedAt: input.completedAt,
    reason,
  });
}

function elevationRoot(stateDirectory) {
  return path.join(path.resolve(stateDirectory), 'environment-foundation', 'setup-elevation');
}

function requestFileFor(stateDirectory, requestId) {
  return path.join(elevationRoot(stateDirectory), 'requests', `${requestId}.json`);
}

function resultFileFor(requestFile) {
  return path.join(path.dirname(path.dirname(requestFile)), 'results', path.basename(requestFile));
}

function journalFileFor(stateDirectory) {
  return path.join(elevationRoot(stateDirectory), 'journal.json');
}

async function atomicWrite(file, value, { exclusive = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(value)}\n`;
  if (exclusive) {
    await writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

async function readBoundedJson(file, name) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 64 * 1024) throw new Error(`${name} must be a bounded real file`);
  return { bytes: await readFile(file), info };
}

function journalRecord(request, requestSha256, phase, extra = {}) {
  return {
    protocol: JOURNAL_PROTOCOL,
    operation: OPERATION,
    requestId: request.requestId,
    requestSha256,
    foundationIdentity: request.foundationIdentity,
    phase,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

async function writeJournal(request, requestSha256, phase, extra = {}) {
  await atomicWrite(journalFileFor(request.stateDirectory), journalRecord(request, requestSha256, phase, extra));
}

async function readFoundationIdentity(stateDirectory) {
  const identityFile = path.join(stateDirectory, 'environment-foundation', 'identity.json');
  const { bytes } = await readBoundedJson(identityFile, 'foundation identity');
  const value = closedObject(JSON.parse(bytes.toString('utf8')), new Set(['protocol', 'token']), 'foundation identity');
  if (value.protocol !== 'devbridge/local-foundation-identity-v1' || typeof value.token !== 'string' || !FOUNDATION_IDENTITY.test(value.token)) {
    throw new Error('foundation identity record is invalid');
  }
  return value.token;
}

function safeProviderEnvironment(environment = process.env) {
  const allow = new Set([
    'ALLUSERSPROFILE', 'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
    'COMSPEC', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROGRAMDATA', 'PROGRAMFILES',
    'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PSMODULEPATH', 'PUBLIC', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP',
    'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'USERNAME', 'USERPROFILE', 'WINDIR',
  ]);
  const result = {};
  for (const [name, value] of Object.entries(environment)) {
    if (allow.has(name.toUpperCase()) && typeof value === 'string') result[name] = value;
  }
  return result;
}

function windowsQuoteArgument(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) return text;
  let quoted = '"';
  let slashes = 0;
  for (const character of text) {
    if (character === '\\') {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat((slashes * 2) + 1);
      quoted += '"';
      slashes = 0;
      continue;
    }
    quoted += '\\'.repeat(slashes);
    slashes = 0;
    quoted += character;
  }
  quoted += '\\'.repeat(slashes * 2);
  return `${quoted}"`;
}

function parseLaunchResult(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    throw new Error(boundedReason(result?.stderr || result?.stdout, 'UAC launcher failed'));
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('UAC launcher returned invalid structured output'); }
  closedObject(value, new Set(['started', 'pid', 'reason', 'errorCode']), 'UAC launcher result');
  if (value.started !== true) return { started: false, reason: boundedReason(value.reason, 'UAC elevation was declined or could not be started') };
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error('UAC launcher returned an invalid process identity');
  return { started: true, pid: value.pid };
}

export async function launchElevatedProviderHelper({
  requestFile,
  requestSha256,
  nodeExecutable = process.execPath,
  helperFile = fileURLToPath(import.meta.url),
  invoke = invokeCommand,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') throw new Error('UAC provider setup is available only on Windows');
  if (typeof requestFile !== 'string' || !path.win32.isAbsolute(requestFile)) throw new TypeError('elevation request file must be an absolute Windows path');
  if (typeof nodeExecutable !== 'string' || !path.win32.isAbsolute(nodeExecutable)) throw new TypeError('elevated Node executable must be an absolute Windows path');
  if (typeof helperFile !== 'string' || !path.win32.isAbsolute(helperFile)) throw new TypeError('elevated helper file must be an absolute Windows path');
  if (typeof requestSha256 !== 'string' || !SHA256.test(requestSha256)) throw new TypeError('elevation request digest is invalid');
  const argumentsText = [helperFile, ELEVATED_SWITCH, requestFile, requestSha256].map(windowsQuoteArgument).join(' ');
  const result = await invoke({
    executable: POWERSHELL,
    arguments: [...COMMAND_ARGS, encodeScript(`${POWERSHELL_PREAMBLE}${ELEVATION_LAUNCH_SCRIPT}`)],
    input: JSON.stringify({ executable: nodeExecutable, arguments: argumentsText }),
    timeoutMs: RESULT_WAIT_MS,
    maxOutputBytes: 64 * 1024,
    environment: safeProviderEnvironment(),
  });
  return parseLaunchResult(result);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForResult(requestFile, timeoutMs) {
  const resultFile = resultFileFor(requestFile);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(resultFile)) return resultFile;
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error('The elevated provider helper did not return a result before the setup deadline. Re-enter setup to reconcile the exact request; do not launch a second helper blindly.');
}

async function loadExactRequest(requestFile, expectedSha256) {
  if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) throw new Error('elevation request digest is invalid');
  const { bytes } = await readBoundedJson(requestFile, 'elevation request');
  if (sha256(bytes) !== expectedSha256) throw new Error('elevation request digest does not match');
  const request = normalizeRequest(JSON.parse(bytes.toString('utf8')));
  const expectedFile = requestFileFor(request.stateDirectory, request.requestId);
  if (path.resolve(requestFile).toLowerCase() !== path.resolve(expectedFile).toLowerCase()) throw new Error('elevation request is outside its exact setup state root');
  const identity = await readFoundationIdentity(request.stateDirectory);
  if (identity !== request.foundationIdentity) throw new Error('elevation request foundation identity does not match local state');
  return request;
}

async function loadExactResult(resultFile, request, requestSha256) {
  const { bytes } = await readBoundedJson(resultFile, 'elevation result');
  return normalizeResult(JSON.parse(bytes.toString('utf8')), request, requestSha256);
}

export async function runElevatedProviderRequest(requestFile, requestSha256, {
  foundationFactory = createEnvironmentFoundation,
  invoke = invokeCommand,
  environment = process.env,
} = {}) {
  let request = null;
  let resultFile = null;
  try {
    request = await loadExactRequest(path.resolve(requestFile), requestSha256);
    resultFile = resultFileFor(requestFile);
    if (existsSync(resultFile)) {
      const existing = await loadExactResult(resultFile, request, requestSha256);
      if (existing.status !== 'succeeded') throw new Error(existing.reason);
      return existing;
    }
    const providerEnvironment = safeProviderEnvironment(environment);
    const foundation = await foundationFactory({
      stateDirectory: request.stateDirectory,
      platform: 'win32',
      invoke: (command) => invoke({ ...command, environment: providerEnvironment }),
    });
    const before = await foundation.inspect();
    if (before.identity !== request.foundationIdentity) throw new Error('elevated provider helper observed a different foundation identity');
    await foundation.ensureNetwork();
    const after = await foundation.inspect();
    if (after.identity !== request.foundationIdentity || after.capabilities?.networking?.ready !== true) {
      throw new Error('owned Hyper-V network was not ready after reconciliation');
    }
    const result = {
      protocol: RESULT_PROTOCOL,
      requestId: request.requestId,
      requestSha256,
      operation: OPERATION,
      foundationIdentity: request.foundationIdentity,
      status: 'succeeded',
      networkingReady: true,
      completedAt: new Date().toISOString(),
      reason: null,
    };
    await atomicWrite(resultFile, result, { exclusive: true });
    return result;
  } catch (error) {
    if (request && resultFile && !existsSync(resultFile)) {
      const result = {
        protocol: RESULT_PROTOCOL,
        requestId: request.requestId,
        requestSha256,
        operation: OPERATION,
        foundationIdentity: request.foundationIdentity,
        status: 'failed',
        networkingReady: false,
        completedAt: new Date().toISOString(),
        reason: boundedReason(error?.message ?? error),
      };
      await atomicWrite(resultFile, result, { exclusive: true }).catch(() => {});
    }
    throw error;
  }
}

async function reconcilePreviousRequest(stateDirectory, foundation, output) {
  const journalFile = journalFileFor(stateDirectory);
  if (!existsSync(journalFile)) return false;
  let journal;
  try {
    const { bytes } = await readBoundedJson(journalFile, 'provider elevation journal');
    journal = closedObject(JSON.parse(bytes.toString('utf8')), new Set([
      'protocol', 'operation', 'requestId', 'requestSha256', 'foundationIdentity', 'phase', 'updatedAt',
      'launchedPid', 'reason', 'recoveredByObservation',
    ]), 'provider elevation journal');
  } catch (error) {
    throw new Error(`Provider elevation recovery state is invalid: ${boundedReason(error?.message ?? error)}`);
  }
  if (journal.protocol !== JOURNAL_PROTOCOL || journal.operation !== OPERATION || !REQUEST_ID.test(journal.requestId) || !SHA256.test(journal.requestSha256) || !FOUNDATION_IDENTITY.test(journal.foundationIdentity)) {
    throw new Error('Provider elevation recovery state has an invalid subject');
  }
  if (!['planned', 'launched', 'reconciled', 'failed'].includes(journal.phase)) throw new Error('Provider elevation recovery phase is invalid');
  const requestFile = requestFileFor(stateDirectory, journal.requestId);
  const request = await loadExactRequest(requestFile, journal.requestSha256);
  const resultFile = resultFileFor(requestFile);
  if (existsSync(resultFile)) {
    const result = await loadExactResult(resultFile, request, journal.requestSha256);
    if (result.status === 'failed') {
      await writeJournal(request, journal.requestSha256, 'failed', { reason: result.reason });
      return false;
    }
  }
  const status = await foundation.inspect();
  if (status.identity !== request.foundationIdentity) throw new Error('Provider elevation recovery foundation identity changed');
  if (status.capabilities?.networking?.ready === true) {
    await writeJournal(request, journal.requestSha256, 'reconciled', { recoveredByObservation: true });
    output.write('Recovered the previous elevated Hyper-V network request by observing the exact owned network as ready.\n');
    return true;
  }
  if (journal.phase === 'planned' || journal.phase === 'launched') {
    output.write('WARNING: A previous elevated Hyper-V network request did not produce a ready observed network. It will not be assumed successful or retried without fresh consent.\n');
  }
  return false;
}

function writeElevationWarning(output, foundationIdentity) {
  output.write(
    '\nWARNING: DevBridge needs one administrator action to reconcile its owned Hyper-V internal switch, gateway, and NAT.\n' +
    `Exact local foundation identity: ${foundationIdentity}\n` +
    'Only the fixed environment-foundation.ensure-network operation will be elevated. The daemon, repository commands, GitHub credentials, and normal runtime stay unelevated.\n' +
    'Windows will show a second UAC consent prompt. Cancel either prompt to make no new elevated attempt.\n',
  );
}

async function requestInteractiveConsent(input, output, promptFactory) {
  const prompt = promptFactory({ input, output });
  try {
    while (true) {
      const answer = (await prompt.question('Type ELEVATE to launch the bounded helper, or CANCEL [CANCEL]: ')).trim();
      if (answer === 'ELEVATE') return true;
      if (!answer || answer === 'CANCEL') return false;
      output.write('  Invalid elevation selection. Enter exactly ELEVATE or CANCEL.\n');
    }
  } finally {
    prompt.close();
  }
}

export async function ensureWindowsFoundationNetwork({
  stateDirectory,
  foundation,
  input = process.stdin,
  output = process.stdout,
  allowElevation = false,
  promptFactory = createInterface,
  launch = launchElevatedProviderHelper,
  waitMs = RESULT_WAIT_MS,
} = {}) {
  if (!foundation || typeof foundation.inspect !== 'function') throw new TypeError('environment foundation is required');
  let status = await foundation.inspect();
  if (existsSync(journalFileFor(stateDirectory)) && await reconcilePreviousRequest(stateDirectory, foundation, output)) {
    return { ready: true, changed: false, recovered: true };
  }
  if (status.capabilities?.networking?.ready === true) return { ready: true, changed: false };
  if (status.capabilities?.management?.ready !== true) {
    throw new Error('Hyper-V management is not usable by the ordinary DevBridge account. Repair feature/service/account authorization first; network elevation alone would not make the runtime usable.');
  }
  writeElevationWarning(output, status.identity);
  let confirmed = allowElevation === true;
  if (!confirmed && input.isTTY === true && output.isTTY === true) confirmed = await requestInteractiveConsent(input, output, promptFactory);
  if (!confirmed) {
    throw new Error('Hyper-V network setup requires explicit elevation consent. Re-run interactive setup, or use --allow-provider-elevation with --confirm APPLY for prescribed setup.');
  }

  const request = normalizeRequest({
    protocol: REQUEST_PROTOCOL,
    requestId: randomUUID(),
    operation: OPERATION,
    stateDirectory: path.resolve(stateDirectory),
    foundationIdentity: status.identity,
    requestedAt: new Date().toISOString(),
  });
  const requestFile = requestFileFor(request.stateDirectory, request.requestId);
  const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
  const requestSha256 = sha256(requestBytes);
  await mkdir(path.dirname(requestFile), { recursive: true, mode: 0o700 });
  await writeFile(requestFile, requestBytes, { mode: 0o600, flag: 'wx' });
  await writeJournal(request, requestSha256, 'planned');

  const launched = await launch({ requestFile, requestSha256 });
  if (launched?.started !== true) {
    const reason = boundedReason(launched?.reason, 'UAC elevation was declined or could not be started');
    await writeJournal(request, requestSha256, 'failed', { reason });
    throw new Error(reason);
  }
  await writeJournal(request, requestSha256, 'launched', { launchedPid: launched.pid });
  const resultFile = await waitForResult(requestFile, waitMs);
  const result = await loadExactResult(resultFile, request, requestSha256);
  if (result.status !== 'succeeded') {
    await writeJournal(request, requestSha256, 'failed', { reason: result.reason });
    throw new Error(`Elevated Hyper-V network setup failed: ${result.reason}`);
  }
  status = await foundation.inspect();
  if (status.identity !== request.foundationIdentity || status.capabilities?.networking?.ready !== true) {
    await writeJournal(request, requestSha256, 'failed', { reason: 'unelevated verification did not observe the exact owned network as ready' });
    throw new Error('The elevated helper reported success, but unelevated verification did not observe the exact owned Hyper-V network as ready.');
  }
  await writeJournal(request, requestSha256, 'reconciled');
  output.write('Verified the exact DevBridge-owned Hyper-V switch, gateway, and NAT after elevation. Normal DevBridge processes remain unelevated.\n');
  return { ready: true, changed: true, requestId: request.requestId };
}

export {
  ELEVATED_SWITCH,
  JOURNAL_PROTOCOL as PROVIDER_ELEVATION_JOURNAL_PROTOCOL,
  OPERATION as PROVIDER_ELEVATION_OPERATION,
  REQUEST_PROTOCOL as PROVIDER_ELEVATION_REQUEST_PROTOCOL,
  RESULT_PROTOCOL as PROVIDER_ELEVATION_RESULT_PROTOCOL,
  elevationRoot as providerElevationRoot,
  resultFileFor as providerElevationResultFile,
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url && process.argv[2] === ELEVATED_SWITCH) {
  const requestFile = process.argv[3];
  const requestSha256 = process.argv[4];
  runElevatedProviderRequest(requestFile, requestSha256).then(() => {
    process.exitCode = 0;
  }).catch(() => {
    process.exitCode = 1;
  });
}
