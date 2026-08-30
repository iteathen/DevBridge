const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

function encodeScript(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$item = Get-Item -LiteralPath ([string]$data.location) -Force -ErrorAction Stop
$reparse = (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
@{ exists = $true; reparse = $reparse } | ConvertTo-Json -Compress
`;

function parse(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new Error('filesystem attribute observation failed');
  let value;
  try { value = JSON.parse(String(result.stdout ?? '')); }
  catch { throw new Error('filesystem attribute observation returned invalid structured output'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.exists !== true || typeof value.reparse !== 'boolean') {
    throw new Error('filesystem attribute observation is invalid');
  }
  return value.reparse;
}

export function createWindowsFilesystemEntryObserver({ invoke } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('filesystem attribute invocation contract is invalid');
  return Object.freeze({
    async isReparse(location) {
      if (typeof location !== 'string' || location.length === 0 || location.length > 32767 || location.includes('\0')) {
        throw new TypeError('filesystem attribute location is invalid');
      }
      return parse(await invoke({
        executable: POWERSHELL,
        arguments: [...POWERSHELL_ARGS, encodeScript(SCRIPT)],
        input: JSON.stringify({ location }),
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      }));
    },
  });
}
