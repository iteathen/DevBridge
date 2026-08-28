import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const WINDOWS_INSTALL_MEDIA_OBSERVATION_PROTOCOL = 'devbridge/windows-install-media-observation-v1';
export const WINDOWS_INSTALL_MEDIA_INVENTORY_PROTOCOL = 'devbridge/windows-install-media-inventory-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^10\.0\.(\d{4,6})\.(\d{1,6})$/u;
const EDITION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$/u;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGUMENTS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

const INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$shouldDismount = $false
$result = $null
try {
  Import-Module Storage -ErrorAction Stop
  Import-Module Dism -ErrorAction Stop
  $disk = Get-DiskImage -ImagePath ([string]$data.location) -ErrorAction SilentlyContinue
  if ($null -eq $disk -or $disk.Attached -ne $true) {
    $disk = Mount-DiskImage -ImagePath ([string]$data.location) -PassThru -ErrorAction Stop
    $shouldDismount = $true
  }
  $volumes = @($disk | Get-Volume -ErrorAction Stop)
  if ($volumes.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$volumes[0].DriveLetter)) { throw 'media-volume' }
  $root = ([string]$volumes[0].DriveLetter) + ':\'
  if (-not (Test-Path -LiteralPath (Join-Path $root 'setup.exe') -PathType Leaf)) { throw 'setup-absent' }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'sources\boot.wim') -PathType Leaf)) { throw 'boot-image-absent' }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'efi\boot\bootx64.efi') -PathType Leaf)) { throw 'efi-loader-absent' }
  $candidates = @(
    @{ container = 'wim'; location = (Join-Path $root 'sources\install.wim') },
    @{ container = 'esd'; location = (Join-Path $root 'sources\install.esd') }
  ) | Where-Object { Test-Path -LiteralPath ([string]$_.location) -PathType Leaf }
  if ($candidates.Count -ne 1) { throw 'install-container' }
  $indices = if ($null -ne $data.index) { @([int]$data.index) } else { @((Get-WindowsImage -ImagePath ([string]$candidates[0].location) -ErrorAction Stop) | ForEach-Object { [int]$_.ImageIndex }) }
  if ($indices.Count -lt 1 -or $indices.Count -gt 512) { throw 'image-count' }
  $images = @($indices | ForEach-Object {
    $selected = Get-WindowsImage -ImagePath ([string]$candidates[0].location) -Index ([int]$_) -ErrorAction Stop
    if ($null -eq $selected) { throw 'image-absent' }
    $languages = @($selected.Languages | ForEach-Object {
      if ($null -ne $_.LanguageTag) { [string]$_.LanguageTag } else { [string]$_ }
    } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $version = [string]$selected.Version
    $parts = @($version.Split('.'))
    if ($parts.Count -ne 4) { throw 'image-version' }
    $defaultLanguage = [string]$selected.DefaultLanguage
    if ([string]::IsNullOrWhiteSpace($defaultLanguage) -and $languages.Count -eq 1) { $defaultLanguage = [string]$languages[0] }
    @{
      index = [int]$selected.ImageIndex
      name = [string]$selected.ImageName
      edition = [string]$selected.EditionId
      architecture = [string]$selected.Architecture
      version = $version
      build = [int]$parts[2]
      installationType = [string]$selected.InstallationType
      languages = $languages
      defaultLanguage = $defaultLanguage
    }
  })
  $result = @{
    ok = $true
    container = [string]$candidates[0].container
    images = $images
  }
} catch {
  $result = @{ ok = $false; code = 'inspection-failed' }
} finally {
  if ($shouldDismount) {
    try { Dismount-DiskImage -ImagePath ([string]$data.location) -ErrorAction Stop | Out-Null }
    catch { $result = @{ ok = $false; code = 'cleanup-failed' } }
  }
}
$result | ConvertTo-Json -Compress -Depth 6
`;

function encodedScript(value) { return Buffer.from(value, 'utf16le').toString('base64'); }

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function boundedText(value, name, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function normalizeArchitecture(value) {
  const selected = String(value ?? '').toLowerCase();
  if (['amd64', 'x64', '9'].includes(selected)) return 'amd64';
  if (['arm64', '12'].includes(selected)) return 'arm64';
  throw new TypeError('Windows media observation image architecture is invalid');
}

function normalizeLanguages(raw, defaultLanguage) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) throw new TypeError('Windows media observation image languages is invalid');
  const languages = [...new Set(raw.map((entry, index) => {
    if (typeof entry !== 'string' || !LANGUAGE.test(entry)) throw new TypeError(`Windows media observation image languages[${index}] is invalid`);
    return entry;
  }))].sort((left, right) => left.localeCompare(right));
  if (typeof defaultLanguage !== 'string' || !LANGUAGE.test(defaultLanguage) || !languages.includes(defaultLanguage)) {
    throw new TypeError('Windows media observation image defaultLanguage is invalid');
  }
  return Object.freeze(languages);
}

function normalizeImage(raw, container, expectedIndex = null) {
  const image = onlyKeys(raw, new Set([
    'index', 'name', 'edition', 'architecture', 'version', 'build', 'installationType', 'languages', 'defaultLanguage',
  ]), 'Windows media observation image');
  if (!Number.isSafeInteger(image.index) || image.index < 1 || image.index > 512 || (expectedIndex != null && image.index !== expectedIndex)) throw new TypeError('Windows media observation image index is invalid');
  const name = boundedText(image.name, 'Windows media observation image name');
  if (typeof image.edition !== 'string' || !EDITION.test(image.edition)) throw new TypeError('Windows media observation image edition is invalid');
  const match = typeof image.version === 'string' ? VERSION.exec(image.version) : null;
  if (!match) throw new TypeError('Windows media observation image version is invalid');
  if (!Number.isSafeInteger(image.build) || image.build !== Number(match[1])) throw new TypeError('Windows media observation image build is invalid');
  if (!['Client', 'Server'].includes(image.installationType)) throw new TypeError('Windows media observation image installationType is invalid');
  const languages = normalizeLanguages(image.languages, image.defaultLanguage);
  return Object.freeze({
    container,
    index: image.index,
    name,
    edition: image.edition,
    architecture: normalizeArchitecture(image.architecture),
    version: image.version,
    build: image.build,
    installationType: image.installationType,
    languages,
    defaultLanguage: image.defaultLanguage,
  });
}

function normalizeObservation(raw, expectedIndex) {
  const value = onlyKeys(raw, new Set(['ok', 'code', 'container', 'images']), 'Windows media observation');
  if (value.ok !== true) {
    const code = typeof value.code === 'string' && /^[a-z][a-z-]{0,63}$/u.test(value.code) ? value.code : 'unavailable';
    throw new Error(`Windows media inspection failed: ${code}`);
  }
  if (!['wim', 'esd'].includes(value.container)) throw new TypeError('Windows media observation container is invalid');
  if (!Array.isArray(value.images) || value.images.length !== 1) throw new TypeError('Windows media observation image count is invalid');
  return normalizeImage(value.images[0], value.container, expectedIndex);
}

function normalizeInventory(raw) {
  const value = onlyKeys(raw, new Set(['ok', 'code', 'container', 'images']), 'Windows media inventory');
  if (value.ok !== true) {
    const code = typeof value.code === 'string' && /^[a-z][a-z-]{0,63}$/u.test(value.code) ? value.code : 'unavailable';
    throw new Error(`Windows media inspection failed: ${code}`);
  }
  if (!['wim', 'esd'].includes(value.container) || !Array.isArray(value.images) || value.images.length < 1 || value.images.length > 512) throw new TypeError('Windows media inventory is invalid');
  const indices = new Set();
  const images = value.images.map((entry) => {
    const image = normalizeImage(entry, value.container);
    if (indices.has(image.index)) throw new TypeError('Windows media inventory image index is duplicated');
    indices.add(image.index);
    return image;
  });
  images.sort((left, right) => left.index - right.index);
  return Object.freeze(images);
}

async function sha256File(location) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function invocationResult(result) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    throw new Error('Windows media inspection operation failed');
  }
  try { return JSON.parse(String(result.stdout ?? '')); }
  catch { throw new Error('Windows media inspection returned invalid structured output'); }
}

export class WindowsInstallMediaInspector {
  #sourceRoot;
  #platform;
  #invoke;

  constructor({ sourceRoot, platform = process.platform, invoke } = {}) {
    if (typeof sourceRoot !== 'string' || sourceRoot.length === 0 || sourceRoot.includes('\0')) throw new TypeError('Windows media source root is required');
    if (typeof platform !== 'string' || platform.length === 0) throw new TypeError('Windows media inspector platform is invalid');
    if (typeof invoke !== 'function') throw new TypeError('Windows media inspector invocation contract is invalid');
    this.#sourceRoot = path.resolve(sourceRoot);
    this.#platform = platform;
    this.#invoke = invoke;
  }

  async #measure(location) {
    if (this.#platform !== 'win32') throw new Error('Windows media inspection requires a Windows host');
    if (typeof location !== 'string' || location.length === 0 || location.includes('\0')) throw new TypeError('Windows media location is invalid');
    const rootInfo = await lstat(this.#sourceRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Windows media source root must be a real directory');
    const root = await realpath(this.#sourceRoot);
    const selected = path.resolve(location);
    const info = await lstat(selected);
    if (!info.isFile() || info.isSymbolicLink() || path.extname(selected).toLowerCase() !== '.iso') throw new Error('Windows media source must be a real ISO file');
    const actual = await realpath(selected);
    const relative = path.relative(root, actual);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Windows media source is outside the owned source root');
    const measuredSha256 = await sha256File(actual);
    return { actual, info, measuredSha256 };
  }

  async #invokeInspection(actual, index) {
    return invocationResult(await this.#invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGUMENTS, encodedScript(INSPECT_SCRIPT)],
      input: JSON.stringify({ location: actual, index }),
      timeoutMs: 5 * 60_000,
      maxOutputBytes: 1024 * 1024,
    }));
  }

  async inspect({ location, expectedSha256, index } = {}) {
    if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) throw new TypeError('Windows media expectedSha256 is invalid');
    if (!Number.isSafeInteger(index) || index < 1 || index > 512) throw new TypeError('Windows media image index is invalid');
    const { actual, info, measuredSha256 } = await this.#measure(location);
    if (measuredSha256 !== expectedSha256) throw new Error('Windows media digest does not match approved authority');
    const image = normalizeObservation(await this.#invokeInspection(actual, index), index);
    return Object.freeze({
      protocol: WINDOWS_INSTALL_MEDIA_OBSERVATION_PROTOCOL,
      media: Object.freeze({ name: path.basename(actual), bytes: info.size, sha256: measuredSha256 }),
      image,
    });
  }

  async inventory({ location } = {}) {
    const { actual, info, measuredSha256 } = await this.#measure(location);
    const images = normalizeInventory(await this.#invokeInspection(actual, null));
    return Object.freeze({
      protocol: WINDOWS_INSTALL_MEDIA_INVENTORY_PROTOCOL,
      media: Object.freeze({ name: path.basename(actual), bytes: info.size, sha256: measuredSha256 }),
      images,
    });
  }
}

export function createWindowsInstallMediaInspector(options) {
  return new WindowsInstallMediaInspector(options);
}
