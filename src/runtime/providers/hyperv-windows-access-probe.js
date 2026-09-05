import { createHyperVEnvironmentLocation } from './hyperv-environment-location.js';
import { HyperVGuestOperation } from './hyperv-guest-operation.js';

const TARGET = /^env-[a-f0-9]{32}$/u;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const ACCOUNT_IDENTITY = /^S-1-5-21-(?:\d+-){3}\d+$/u;

const INSPECT_OPERATION = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$groups = @($identity.Groups | ForEach-Object { [string]$_.Value })
$name = ([string]$identity.Name).Split('\\')[-1]
$standard = $groups -contains 'S-1-5-32-545'
$remote = $groups -contains 'S-1-5-32-580'
$administrator = $groups -contains 'S-1-5-32-544'
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$bridge = (Test-Path -LiteralPath 'C:\ProgramData\DevBridge\bridge-agent.mjs' -PathType Leaf) -and (Test-Path -LiteralPath 'C:\ProgramData\DevBridge\environment-bootstrap-agent.mjs' -PathType Leaf)
$node = $null -ne (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)
if ($name -ne [string]$operationInput.user) { throw 'access account does not match' }
if (-not $standard -or -not $remote -or $administrator -or $elevated) { throw 'access account boundary does not match' }
if (-not $bridge -or -not $node) { throw 'access payload is unavailable' }
@{
  ready = $true
  user = $name
  accountIdentity = [string]$identity.User.Value
  standardAccess = $standard
  remoteAccess = $remote
  elevated = $elevated
  bridge = $bridge
  runtime = $node
} | ConvertTo-Json -Compress
`;

function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('access probe request must be an object');
  for (const key of Object.keys(raw)) if (!new Set(['target', 'connection']).has(key)) throw new TypeError(`access probe request.${key} is not allowed`);
  if (typeof raw.target !== 'string' || !TARGET.test(raw.target)) throw new TypeError('access probe target is invalid');
  const connection = raw.connection;
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw new TypeError('access probe connection must be an object');
  for (const key of Object.keys(connection)) if (!new Set(['family', 'username', 'password']).has(key)) throw new TypeError(`access probe connection.${key} is not allowed`);
  if (connection.family !== 'windows') throw new TypeError('access probe connection family is invalid');
  if (typeof connection.username !== 'string' || !USER.test(connection.username)) throw new TypeError('access probe connection user is invalid');
  if (typeof connection.password !== 'string' || connection.password.length === 0 || connection.password.includes('\0') || Buffer.byteLength(connection.password, 'utf8') > 16_384) {
    throw new TypeError('access probe connection secret is invalid');
  }
  return { target: raw.target, connection };
}

function validEvidence(value, user) {
  return value?.ready === true
    && value.user === user
    && typeof value.accountIdentity === 'string'
    && ACCOUNT_IDENTITY.test(value.accountIdentity)
    && value.standardAccess === true
    && value.remoteAccess === true
    && value.elevated === false
    && value.bridge === true
    && value.runtime === true;
}

export class HyperVWindowsAccessProbe {
  #invoke;
  #location;

  constructor({ identity, invoke } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('access probe invocation contract is invalid');
    this.#invoke = invoke;
    this.#location = createHyperVEnvironmentLocation(identity);
  }

  async inspect(raw) {
    let request;
    try { request = normalizeRequest(raw); }
    catch (error) { return Object.freeze({ ready: false, reason: error.message }); }
    const operation = new HyperVGuestOperation({
      invoke: this.#invoke,
      locate: async (target) => this.#location.environment(target),
      access: async (target) => {
        if (target !== request.target) throw new Error('access probe target changed');
        return { user: request.connection.username, secret: request.connection.password };
      },
      operations: { 'inspect-v1': INSPECT_OPERATION },
    });
    try {
      const evidence = await operation.execute({ target: request.target, operation: 'inspect-v1', input: { user: request.connection.username }, timeoutMs: 30_000 });
      if (!validEvidence(evidence, request.connection.username)) return Object.freeze({ ready: false, reason: 'access probe evidence is invalid' });
      return Object.freeze({ ready: true, reason: null, accountIdentity: evidence.accountIdentity });
    } catch {
      return Object.freeze({ ready: false, reason: 'access endpoint is unavailable' });
    }
  }
}

export function createHyperVWindowsAccessProbe(options) {
  return new HyperVWindowsAccessProbe(options);
}
