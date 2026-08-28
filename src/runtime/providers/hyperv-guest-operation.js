const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const EXECUTE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.reference) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.proof) { throw 'guest operation ownership proof does not match' }
if ([string]$item.State -ne 'Running') { throw 'guest operation target is not running' }
$secure = ConvertTo-SecureString ([string]$data.secret) -AsPlainText -Force
$credential = [Management.Automation.PSCredential]::new([string]$data.user, $secure)
$session = New-PSSession -VMName ([string]$data.reference) -Credential $credential -ErrorAction Stop
try {
  $output = @(Invoke-Command -Session $session -ArgumentList ([string]$data.operation), ([string]$data.operationInput) -ScriptBlock {
    param($encodedOperation, $encodedInput)
    $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedOperation))
    $operationInput = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedInput)) | ConvertFrom-Json
    $block = [ScriptBlock]::Create($source)
    & $block
  } -ErrorAction Stop)
  if ($output.Count -ne 1) { throw 'guest operation output count is invalid' }
  @{ ok = $true; output = [string]$output[0] } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}
`;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function bounded(value, name, maxBytes = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeOperations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new TypeError('guest operations must be a plain object');
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > 32) throw new TypeError('guest operations are invalid');
  const result = new Map();
  for (const [identity, script] of entries) {
    if (!OPERATION.test(identity)) throw new TypeError('guest operation identity is invalid');
    result.set(identity, bounded(script, `guest operation ${identity}`, MAX_SCRIPT_BYTES));
  }
  return result;
}

function encodedScript(value) { return Buffer.from(value, 'utf16le').toString('base64'); }

function jsonInput(value) {
  let text;
  try { text = JSON.stringify(value); } catch { throw new TypeError('guest operation input is not JSON data'); }
  if (text == null || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new TypeError('guest operation input is invalid');
  try { return JSON.stringify(JSON.parse(text)); } catch { throw new TypeError('guest operation input is not JSON data'); }
}

function normalizeLocation(raw) {
  const value = onlyKeys(raw, new Set(['reference', 'proof']), 'guest operation location');
  return { reference: bounded(value.reference, 'guest operation location.reference', 512), proof: bounded(value.proof, 'guest operation location.proof', 2048) };
}

function normalizeAccess(raw) {
  const value = onlyKeys(raw, new Set(['user', 'secret']), 'guest operation access');
  return { user: bounded(value.user, 'guest operation access.user', 512), secret: bounded(value.secret, 'guest operation access.secret', 16_384) };
}

function parseResult(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new Error('guest operation failed');
  let envelope;
  try { envelope = JSON.parse(String(result.stdout ?? '')); } catch { throw new Error('guest operation returned invalid structured output'); }
  if (envelope?.ok !== true || typeof envelope.output !== 'string' || Buffer.byteLength(envelope.output, 'utf8') > MAX_OUTPUT_BYTES) throw new Error('guest operation returned invalid structured output');
  try { return JSON.parse(envelope.output); } catch { throw new Error('guest operation returned invalid structured output'); }
}

export class HyperVGuestOperation {
  #invoke;
  #locate;
  #access;
  #operations;

  constructor({ invoke, locate, access, operations } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('guest operation invocation contract is invalid');
    if (typeof locate !== 'function') throw new TypeError('guest operation location contract is invalid');
    if (typeof access !== 'function') throw new TypeError('guest operation access contract is invalid');
    this.#invoke = invoke;
    this.#locate = locate;
    this.#access = access;
    this.#operations = normalizeOperations(operations);
  }

  async execute(raw, { signal = null } = {}) {
    const value = onlyKeys(raw, new Set(['target', 'operation', 'input', 'timeoutMs']), 'guest operation request');
    if (typeof value.target !== 'string' || !TARGET.test(value.target)) throw new TypeError('guest operation target is invalid');
    if (typeof value.operation !== 'string' || !OPERATION.test(value.operation)) throw new TypeError('guest operation identity is invalid');
    const script = this.#operations.get(value.operation);
    if (!script) throw new Error('guest operation is not registered');
    const timeoutMs = value.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60_000) throw new TypeError('guest operation timeoutMs is invalid');
    const serializedInput = jsonInput(value.input);
    const [location, access] = await Promise.all([this.#locate(value.target), this.#access(value.target)]);
    const selectedLocation = normalizeLocation(location);
    const selectedAccess = normalizeAccess(access);
    return parseResult(await this.#invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(EXECUTE_SCRIPT)],
      input: JSON.stringify({
        ...selectedLocation,
        ...selectedAccess,
        operation: Buffer.from(script, 'utf8').toString('base64'),
        operationInput: Buffer.from(serializedInput, 'utf8').toString('base64'),
      }),
      timeoutMs,
      maxOutputBytes: 2 * MAX_OUTPUT_BYTES,
      signal,
    }));
  }
}

export function createHyperVGuestOperation(options) {
  return new HyperVGuestOperation(options);
}
