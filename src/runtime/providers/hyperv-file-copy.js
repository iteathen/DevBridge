import { copyFile, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$code = 'management-failed'
$attempted = $false
try {
  Import-Module Hyper-V -ErrorAction Stop
  $item = Get-VM -Name ([string]$data.reference) -ErrorAction Stop
  $code = 'ownership-mismatch'
  if ([string]$item.Notes -ne [string]$data.proof) { throw 'environment ownership proof does not match' }
  $code = 'guest-not-running'
  if ([string]$item.State -ne 'Running') { throw 'environment is not running' }
  $code = 'service-unavailable'
  $service = Get-VMIntegrationService -VMName ([string]$data.reference) -ErrorAction Stop | Where-Object { $_.Name -eq 'Guest Service Interface' } | Select-Object -First 1
  if ($null -eq $service -or -not $service.Enabled) { throw 'guest file service is not enabled' }
  $code = 'service-not-ready'
  if ([string]$service.PrimaryOperationalStatus -ne 'Ok') { throw 'guest file service has no contact' }
  $code = 'copy-failed'
  $attempted = $true
  Copy-VMFile -VMName ([string]$data.reference) -SourcePath ([string]$data.source) -DestinationPath ([string]$data.destination) -FileSource Host -CreateFullPath -Force -ErrorAction Stop
  @{ delivered = $true } | ConvertTo-Json -Compress
} catch {
  $category = [string]$_.CategoryInfo.Category
  if ($category -eq 'InvalidArgument' -or $category -eq 'InvalidData') { $code = 'invalid-argument' }
  @{ delivered = $false; failure = @{ code = $code; attempted = $attempted; category = $category; nativeCode = ('0x{0:X8}' -f $_.Exception.HResult); message = [string]$_.Exception.Message } } | ConvertTo-Json -Depth 4 -Compress
}
`;

function bounded(value, name, limit = 4096) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value) || Buffer.byteLength(value, 'utf8') > limit) throw new TypeError(`${name} is invalid`);
  return value;
}

function destinationPath(destination, family) {
  const selected = bounded(destination, 'guest file destination');
  const syntax = family === 'linux' ? path.posix : path.win32;
  if (!syntax.isAbsolute(selected) || syntax.normalize(selected) !== selected || /[\\/]$/u.test(selected)
    || (family === 'linux' && selected.includes('\\'))
    || (family === 'windows' && !/^[A-Za-z]:\\/u.test(selected))) {
    throw new TypeError('guest file destination must be a normalized absolute filename');
  }
  const basename = syntax.basename(selected);
  // Linux destinations must also be representable as a Windows source basename.
  if (/[<>:"\\|?*]/u.test(basename) || /[. ]$/u.test(basename)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(basename)) throw new TypeError('guest file basename is not representable by Hyper-V');
  return { selected, basename, directory: syntax.dirname(selected) };
}

function evidence(result, failure) {
  const text = (value) => String(value ?? '').slice(0, 2048);
  const stdout = text(result?.stdout);
  const stderr = text(result?.stderr);
  return Object.freeze({
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    timedOut: result?.timedOut === true,
    aborted: result?.aborted === true,
    outputTruncated: result?.outputTruncated === true || String(result?.stdout ?? '').length > stdout.length || String(result?.stderr ?? '').length > stderr.length,
    stdout, stderr,
    nativeCode: failure?.nativeCode == null ? null : text(failure.nativeCode),
    category: failure?.category == null ? null : text(failure.category),
  });
}

export class HyperVFileCopyError extends Error {
  constructor(result, failure = null) {
    const code = typeof failure?.code === 'string' ? failure.code.slice(0, 128) : 'copy-outcome-unknown';
    const detail = String(failure?.message || result?.stderr || 'native copy did not return confirmed completion').trim().slice(0, 2048);
    super(`guest file delivery ${code}: ${detail}`);
    this.name = 'HyperVFileCopyError';
    this.code = code;
    this.retryable = failure?.attempted === false && ['guest-not-running', 'service-not-ready'].includes(code);
    this.effect = failure?.attempted === false ? 'not-attempted' : 'uncertain';
    this.evidence = evidence(result, failure);
  }
}

export async function copyHyperVGuestFile({ invoke, location, family, source, destination, timeoutMs = 30_000, signal } = {}) {
  if (typeof invoke !== 'function' || !['linux', 'windows'].includes(family)) throw new TypeError('Hyper-V copy contract is invalid');
  if (!REFERENCE.test(location?.reference ?? '')) throw new TypeError('Hyper-V copy reference is invalid');
  const proof = bounded(location?.proof, 'Hyper-V copy ownership proof', 2048);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new TypeError('Hyper-V copy timeout is invalid');
  const guest = destinationPath(destination, family);
  const lexical = bounded(source, 'guest file delivery source');
  const info = await lstat(lexical);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('guest file delivery source must be a real regular file');
  const localSource = await realpath(lexical);
  let staging = null;
  try {
    let nativeSource = localSource;
    if (family === 'linux') {
      staging = await mkdtemp(path.join(path.dirname(localSource), '.guest-delivery-'));
      nativeSource = path.join(staging, guest.basename);
      await copyFile(localSource, nativeSource);
    }
    const result = await invoke({
      executable: 'powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      input: JSON.stringify({ reference: location.reference, proof, source: nativeSource, destination: family === 'linux' ? `${guest.directory.replace(/\/$/u, '')}/` : guest.selected }),
      timeoutMs, maxOutputBytes: 256 * 1024, ...(signal == null ? {} : { signal }),
    });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) throw new HyperVFileCopyError(result);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { throw new HyperVFileCopyError(result); }
    if (parsed?.delivered !== true) throw new HyperVFileCopyError(result, parsed?.failure);
    return Object.freeze({ delivered: true });
  } finally {
    if (staging != null) await rm(staging, { recursive: true, force: true });
  }
}
