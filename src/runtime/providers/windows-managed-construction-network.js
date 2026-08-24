const PROTOCOL = 'devbridge/windows-managed-construction-network-v1';
const SWITCH_ID = 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444';
const PROOF = SWITCH_ID;
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

function encodeScript(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

function parseJson(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    const detail = String(result?.stderr || result?.stdout || 'managed construction network observation failed').trim().slice(0, 2_048);
    throw new Error(detail || 'managed construction network observation failed');
  }
  try { return JSON.parse(String(result.stdout ?? '')); }
  catch { throw new Error('managed construction network observation returned invalid structured output'); }
}

const INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$switch = Get-VMSwitch -Id ([guid]$data.reference) -ErrorAction SilentlyContinue
if ($null -eq $switch) { @{ ready = $false; reason = 'Windows-managed construction network is absent' } | ConvertTo-Json -Compress; exit 0 }
if (([string]$switch.Id).ToLowerInvariant() -ne ([string]$data.reference).ToLowerInvariant()) { @{ ready = $false; reason = 'Windows-managed construction network identity changed' } | ConvertTo-Json -Compress; exit 0 }
if ([string]$switch.SwitchType -ne 'Internal') { @{ ready = $false; reason = 'Windows-managed construction network type is incompatible' } | ConvertTo-Json -Compress; exit 0 }
@{ ready = $true; reason = $null } | ConvertTo-Json -Compress
`;

function description() {
  return Object.freeze({
    protocol: PROTOCOL,
    binding: Object.freeze({ control: 'system', reference: SWITCH_ID, proof: PROOF }),
    addressing: Object.freeze({ method: 'automatic' }),
  });
}

export class WindowsManagedConstructionNetwork {
  #invoke;

  constructor({ invoke } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('managed construction network invocation contract is invalid');
    this.#invoke = invoke;
  }

  async inspect() {
    try {
      const observed = parseJson(await this.#invoke({
        executable: POWERSHELL,
        arguments: [...POWERSHELL_ARGS, encodeScript(INSPECT_SCRIPT)],
        input: JSON.stringify({ reference: SWITCH_ID }),
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      }));
      if (observed?.ready !== true) return Object.freeze({ ready: false, reason: String(observed?.reason ?? 'Windows-managed construction network is unavailable'), description: null });
      return Object.freeze({ ready: true, reason: null, description: description() });
    } catch (error) {
      return Object.freeze({ ready: false, reason: `Windows-managed construction network observation failed: ${error.message}`, description: null });
    }
  }

  async require() {
    const observed = await this.inspect();
    if (!observed.ready) throw new Error(observed.reason ?? 'Windows-managed construction network is unavailable');
    return observed.description;
  }
}

export function createWindowsManagedConstructionNetwork(options) {
  return new WindowsManagedConstructionNetwork(options);
}

export {
  PROTOCOL as WINDOWS_MANAGED_CONSTRUCTION_NETWORK_PROTOCOL,
  SWITCH_ID as WINDOWS_MANAGED_CONSTRUCTION_NETWORK_ID,
};
