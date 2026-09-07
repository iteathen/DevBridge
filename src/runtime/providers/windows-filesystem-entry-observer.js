const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const RESULT_PROTOCOL = 'devbridge/windows-filesystem-entry-observation-v1';
const MAX_BATCH_ENTRIES = 512;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function encodeScript(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$locations = @($data.locations)
$results = for ($index = 0; $index -lt $locations.Count; $index += 1) {
  $location = [string]$locations[$index]
  if (-not (Test-Path -LiteralPath $location -PathType Any -ErrorAction Stop)) {
    @{ index = $index; exists = $false; reparse = $false }
    continue
  }
  $item = Get-Item -LiteralPath $location -Force -ErrorAction Stop
  $reparse = (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  @{ index = $index; exists = $true; reparse = $reparse }
}
@{ protocol = '${RESULT_PROTOCOL}'; results = @($results) } | ConvertTo-Json -Compress -Depth 4
`;

function locations(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BATCH_ENTRIES) {
    throw new TypeError('filesystem attribute locations are invalid');
  }
  const selected = raw.map((location) => {
    if (typeof location !== 'string' || location.length === 0 || location.length > 32767 || location.includes('\0')) {
      throw new TypeError('filesystem attribute location is invalid');
    }
    return location;
  });
  const input = JSON.stringify({ locations: selected });
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw new TypeError('filesystem attribute locations exceed their byte bound');
  return Object.freeze({ selected: Object.freeze(selected), input });
}

function parse(result, expectedCount) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new Error('filesystem attribute observation failed');
  let value;
  try { value = JSON.parse(String(result.stdout ?? '')); }
  catch { throw new Error('filesystem attribute observation returned invalid structured output'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.protocol !== RESULT_PROTOCOL || !Array.isArray(value.results) || value.results.length !== expectedCount
      || Object.keys(value).some((key) => !['protocol', 'results'].includes(key))) {
    throw new Error('filesystem attribute observation is invalid');
  }
  return Object.freeze(value.results.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).some((key) => !['index', 'exists', 'reparse'].includes(key))
        || raw.index !== index || typeof raw.exists !== 'boolean' || typeof raw.reparse !== 'boolean'
        || (!raw.exists && raw.reparse)) {
      throw new Error('filesystem attribute observation is invalid');
    }
    return Object.freeze({ exists: raw.exists, reparse: raw.reparse });
  }));
}

export function createWindowsFilesystemEntryObserver({ invoke } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('filesystem attribute invocation contract is invalid');
  async function inspectReparseBatch(rawLocations) {
    const selected = locations(rawLocations);
    return parse(await invoke({
        executable: POWERSHELL,
        arguments: [...POWERSHELL_ARGS, encodeScript(SCRIPT)],
        input: selected.input,
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      }), selected.selected.length);
  }
  return Object.freeze({
    inspectReparseBatch,
    async isReparse(location) {
      const [result] = await inspectReparseBatch([location]);
      if (!result.exists) throw new Error('filesystem attribute target is unavailable');
      return result.reparse;
    },
  });
}
