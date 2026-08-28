import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeWindowsToolchainAuthority } from '../../setup/windows-toolchain-authority.js';

const PAYLOAD_PROTOCOL = 'devbridge/windows-guest-image-payload-v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TARGET_ROOT = 'C:\\ProgramData\\DevBridge';

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function normalizePayload(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'generation', 'files']), 'production payload');
  if (value.protocol !== PAYLOAD_PROTOCOL) throw new TypeError('production payload protocol is unsupported');
  if (typeof value.generation !== 'string' || !GENERATION.test(value.generation)) throw new TypeError('production payload generation is invalid');
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 32) throw new TypeError('production payload files are invalid');
  const names = new Set();
  let totalBytes = 0;
  const files = value.files.map((rawFile, index) => {
    const file = onlyKeys(rawFile, new Set(['path', 'content', 'bytes', 'sha256']), `production payload files[${index}]`);
    if (typeof file.path !== 'string' || path.win32.dirname(file.path) !== TARGET_ROOT) throw new TypeError(`production payload files[${index}].path is invalid`);
    const key = file.path.toLowerCase();
    if (names.has(key)) throw new TypeError(`production payload files[${index}].path is duplicated`);
    names.add(key);
    if (typeof file.content !== 'string' || file.content.length === 0 || file.content.includes('\0')) throw new TypeError(`production payload files[${index}].content is invalid`);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    const digest = createHash('sha256').update(file.content, 'utf8').digest('hex');
    if (file.bytes !== bytes || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256) || file.sha256 !== digest) throw new TypeError(`production payload files[${index}] digest does not match`);
    totalBytes += bytes;
    if (totalBytes > 2 * 1024 * 1024) throw new TypeError('production payload exceeds its total bound');
    return { path: file.path, content: file.content, bytes, sha256: digest };
  });
  return { protocol: PAYLOAD_PROTOCOL, generation: value.generation, files };
}

function manifestHeader(manifest) {
  const encoded = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
  return `$manifestBase64 = '${encoded}'\n$manifest = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($manifestBase64)) | ConvertFrom-Json\n`;
}

const PREPARE_BODY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$root = 'C:\ProgramData\DevBridge'
$artifactRoot = Join-Path $root 'ImageConstruction\artifacts'
$null = New-Item -ItemType Directory -Path $artifactRoot -Force

function Invoke-BoundedProcess([string]$File, [string[]]$Arguments, [string]$Name) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -Wait -NoNewWindow -PassThru
  if (@(0, 3010) -notcontains [int]$process.ExitCode) { throw ($Name + ' exited outside the accepted contract') }
  return [int]$process.ExitCode
}

function Get-ExactArtifact($item) {
  $extension = if ([string]$item.identity -eq 'node') { '.msi' } else { '.exe' }
  $location = Join-Path $artifactRoot (([string]$item.identity) + $extension)
  $valid = Test-Path -LiteralPath $location -PathType Leaf
  if ($valid) {
    $file = Get-Item -LiteralPath $location -ErrorAction Stop
    $digest = (Get-FileHash -LiteralPath $location -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    $valid = [long]$file.Length -eq [long]$item.bytes -and $digest -eq [string]$item.sha256
  }
  if (-not $valid) {
    Remove-Item -LiteralPath $location -Force -ErrorAction SilentlyContinue
    $partial = $location + '.partial'
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -UseBasicParsing -Uri ([uri][string]$item.uri) -OutFile $partial -MaximumRedirection 5 -ErrorAction Stop
    $file = Get-Item -LiteralPath $partial -ErrorAction Stop
    $digest = (Get-FileHash -LiteralPath $partial -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ([long]$file.Length -ne [long]$item.bytes -or $digest -ne [string]$item.sha256) { throw 'downloaded artifact identity does not match' }
    Move-Item -LiteralPath $partial -Destination $location -ErrorAction Stop
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $location -ErrorAction Stop
  if ([string]$signature.Status -ne 'Valid') { throw 'downloaded artifact signature is not valid' }
  return $location
}

$artifacts = @{}
foreach ($item in @($manifest.authority.artifacts)) { $artifacts[[string]$item.identity] = Get-ExactArtifact $item }
$buildAuthority = @($manifest.authority.artifacts | Where-Object { $_.identity -eq 'build-tools' })[0]

$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
$buildPath = $null
$buildVersion = $null
if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
  $buildPath = (& $vswhere -latest -products Microsoft.VisualStudio.Product.BuildTools -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
  $buildVersion = (& $vswhere -latest -products Microsoft.VisualStudio.Product.BuildTools -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion | Select-Object -First 1)
}
if (-not [string]::IsNullOrWhiteSpace([string]$buildPath) -and [string]$buildVersion -ne [string]$buildAuthority.installedVersion) { throw 'existing native build suite version conflicts with construction authority' }
if ([string]::IsNullOrWhiteSpace([string]$buildPath)) {
  $null = Invoke-BoundedProcess $artifacts['build-tools'] @(
    '--quiet', '--wait', '--norestart', '--nocache', '--noUpdateInstaller',
    '--channelUri', 'C:\ProgramData\DevBridge\ImageConstruction\disabled-channel.chman',
    '--installPath', '"C:\Program Files\Microsoft Visual Studio\2022\BuildTools"',
    '--add', 'Microsoft.VisualStudio.Workload.VCTools',
    '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '--add', 'Microsoft.VisualStudio.Component.VC.CMake.Project',
    '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.26100'
  ) 'build tools installation'
}

$nodeExpected = 'v' + [string](@($manifest.authority.artifacts | Where-Object { $_.identity -eq 'node' })[0].version)
$nodeActual = if (Get-Command node.exe -ErrorAction SilentlyContinue) { (& node.exe --version).Trim() } else { $null }
if ($null -ne $nodeActual -and $nodeActual -ne $nodeExpected) { throw 'existing runtime version conflicts with construction authority' }
if ($null -eq $nodeActual) { $null = Invoke-BoundedProcess 'msiexec.exe' @('/i', $artifacts['node'], '/qn', '/norestart', 'ADDLOCAL=ALL') 'runtime installation' }

$sourceExpected = [string](@($manifest.authority.artifacts | Where-Object { $_.identity -eq 'source-control' })[0].version)
$sourceActual = if (Get-Command git.exe -ErrorAction SilentlyContinue) { (& git.exe --version).Trim() } else { $null }
if ($null -ne $sourceActual -and $sourceActual -notmatch [regex]::Escape($sourceExpected)) { throw 'existing source tool version conflicts with construction authority' }
if ($null -eq $sourceActual) { $null = Invoke-BoundedProcess $artifacts['source-control'] @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/CLOSEAPPLICATIONS', '/o:PathOption=Cmd') 'source tool installation' }

$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$knownPaths = @('C:\Program Files\nodejs', 'C:\Program Files\Git\cmd')
foreach ($candidate in $knownPaths) { if ($machinePath -notlike ('*' + $candidate + '*')) { $machinePath = $machinePath.TrimEnd(';') + ';' + $candidate } }
[Environment]::SetEnvironmentVariable('Path', $machinePath, 'Machine')
$env:Path = $machinePath + ';' + [Environment]::GetEnvironmentVariable('Path', 'Process')

$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
$buildPath = (& $vswhere -latest -products Microsoft.VisualStudio.Product.BuildTools -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace([string]$buildPath)) { throw 'build tools did not become discoverable' }
$buildVersion = (& $vswhere -latest -products Microsoft.VisualStudio.Product.BuildTools -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion | Select-Object -First 1)
if ([string]$buildVersion -ne [string]$buildAuthority.installedVersion) { throw 'installed native build suite version does not match construction authority' }
$dev = Join-Path $buildPath 'Common7\Tools\VsDevCmd.bat'
$lines = @(& $env:ComSpec /d /s /c ('""' + $dev + '" -no_logo -arch=x64 -host_arch=x64 && set"'))
foreach ($name in @('Path', 'INCLUDE', 'LIB', 'LIBPATH', 'VCINSTALLDIR', 'VSINSTALLDIR', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion', 'UCRTVersion', 'UniversalCRTSdkDir')) {
  $prefix = $name + '='
  $line = $lines | Where-Object { $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -Last 1
  if ($null -ne $line) { [Environment]::SetEnvironmentVariable($name, $line.Substring($prefix.Length), 'Machine') }
}

$encoding = [Text.UTF8Encoding]::new($false)
foreach ($file in @($manifest.payload.files)) {
  $destination = [IO.Path]::GetFullPath([string]$file.path)
  if (-not $destination.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'payload destination escaped its local root' }
  $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force
  $bytes = $encoding.GetBytes([string]$file.content)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = -join @($algorithm.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) }
  finally { $algorithm.Dispose() }
  if ([long]$bytes.Length -ne [long]$file.bytes -or $digest -ne [string]$file.sha256) { throw 'payload identity does not match' }
  $temporary = $destination + '.pending'
  [IO.File]::WriteAllBytes($temporary, $bytes)
  Move-Item -LiteralPath $temporary -Destination $destination -Force
}

$null = New-Item -ItemType Directory -Path (Join-Path $root 'access') -Force
$null = New-Item -ItemType Directory -Path (Join-Path $root 'bootstrap') -Force
$null = New-Item -ItemType Directory -Path (Join-Path $root 'bridge') -Force
& icacls.exe $root '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-32-545:(OI)(CI)(RX)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'payload root protection failed' }
& icacls.exe (Join-Path $root 'access') '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'access root protection failed' }
foreach ($writable in @((Join-Path $root 'bootstrap'), (Join-Path $root 'bridge'))) {
  & icacls.exe $writable '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-32-545:(OI)(CI)(M)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'runtime state root protection failed' }
}

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'runtime executable is absent after installation' }
$services = @(
  @{ name = 'DevBridgeAccessSeed'; script = (Join-Path $root 'windows-access-seed-agent.mjs') },
  @{ name = 'DevBridgeNetworkSeed'; script = (Join-Path $root 'network-seed-agent.mjs') }
)
foreach ($definition in $services) {
  $command = '"' + $node + '" "' + [string]$definition.script + '" --watch'
  $existing = Get-CimInstance Win32_Service -Filter ("Name='" + [string]$definition.name + "'") -ErrorAction SilentlyContinue
  if ($null -eq $existing) { $null = New-Service -Name ([string]$definition.name) -BinaryPathName $command -StartupType Automatic -ErrorAction Stop }
  elseif ([string]$existing.PathName -ne $command) { throw 'guest service definition changed' }
  Set-Service -Name ([string]$definition.name) -StartupType Automatic -ErrorAction Stop
  if ((Get-Service -Name ([string]$definition.name) -ErrorAction Stop).Status -ne 'Running') { Start-Service -Name ([string]$definition.name) -ErrorAction Stop }
}

$system = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
$bootIdentity = ([DateTime]$system.LastBootUpTime).ToUniversalTime().ToString('o')
@{ prepared = $true; generation = [string]$manifest.authority.generation; payloadGeneration = [string]$manifest.payload.generation; nativeBuildVersion = [string]$buildVersion; bootIdentity = $bootIdentity; restartRequired = $true } | ConvertTo-Json -Compress
`;

const STATUS_BODY = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$system = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
$bootIdentity = ([DateTime]$system.LastBootUpTime).ToUniversalTime().ToString('o')
$ready = Test-Path -LiteralPath 'C:\ProgramData\DevBridge\ImageConstruction\ready-v1' -PathType Leaf
@{ protocol = 'devbridge/windows-production-status-v1'; bootIdentity = $bootIdentity; ready = [bool]$ready } | ConvertTo-Json -Compress
`;

const QUALIFY_BODY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$root = 'C:\ProgramData\DevBridge'
foreach ($name in @('Path', 'INCLUDE', 'LIB', 'LIBPATH', 'VCINSTALLDIR', 'VSINSTALLDIR', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion', 'UCRTVersion', 'UniversalCRTSdkDir')) {
  $value = [Environment]::GetEnvironmentVariable($name, 'Machine')
  if ($null -ne $value) { Set-Item -LiteralPath ('Env:' + $name) -Value $value }
}
foreach ($file in @($manifest.payload.files)) {
  if (-not (Test-Path -LiteralPath ([string]$file.path) -PathType Leaf) -or (Get-Item -LiteralPath ([string]$file.path)).Length -ne [long]$file.bytes -or (Get-FileHash -LiteralPath ([string]$file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$file.sha256) { throw 'installed payload identity does not match' }
}
foreach ($name in @('DevBridgeAccessSeed', 'DevBridgeNetworkSeed')) {
  $service = Get-CimInstance Win32_Service -Filter ("Name='" + $name + "'") -ErrorAction Stop
  if ([string]$service.StartMode -ne 'Auto' -or [string]$service.State -ne 'Running' -or [string]$service.StartName -ne 'LocalSystem') { throw 'guest service is not ready' }
}
$node = (& node.exe --version).Trim()
$npm = (& npm.cmd --version).Trim()
$git = (& git.exe --version).Trim()
$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
$nativeBuild = (& $vswhere -latest -products Microsoft.VisualStudio.Product.BuildTools -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion | Select-Object -First 1)
$cmakePath = (Get-Command cmake.exe -ErrorAction Stop).Source
$ctestPath = (Get-Command ctest.exe -ErrorAction Stop).Source
$compilerPath = (Get-Command cl.exe -ErrorAction Stop).Source
$cmake = (& $cmakePath --version | Select-Object -First 1).Trim()
$compiler = [Diagnostics.FileVersionInfo]::GetVersionInfo($compilerPath).FileVersion
if (@(Resolve-DnsName example.com -Type A -ErrorAction Stop).Count -lt 1) { throw 'name resolution did not return an address' }
$response = Invoke-WebRequest -UseBasicParsing -Uri 'https://example.com/' -Method Head -TimeoutSec 15 -ErrorAction Stop
if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 500) { throw 'secure web probe returned an unusable status' }
$scratch = Join-Path $env:TEMP ('devbridge-qualification-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $scratch
try {
  $cmakeSource = @'
cmake_minimum_required(VERSION 3.20)
project(devbridge_image_probe C)
enable_testing()
add_executable(probe main.c)
add_test(NAME probe COMMAND probe)
'@
  $cSource = @'
#include <stdio.h>
int main(void) { puts("devbridge-image-probe"); return 0; }
'@
  [IO.File]::WriteAllText((Join-Path $scratch 'CMakeLists.txt'), $cmakeSource, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $scratch 'main.c'), $cSource, [Text.UTF8Encoding]::new($false))
  & $cmakePath -S $scratch -B (Join-Path $scratch 'build') *> $null
  if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed' }
  & $cmakePath --build (Join-Path $scratch 'build') --config Release *> $null
  if ($LASTEXITCODE -ne 0) { throw 'CMake build failed' }
  & $ctestPath --test-dir (Join-Path $scratch 'build') -C Release --output-on-failure *> $null
  if ($LASTEXITCODE -ne 0) { throw 'CTest failed' }
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
$system = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
$bootIdentity = ([DateTime]$system.LastBootUpTime).ToUniversalTime().ToString('o')
$edition = [string](Get-WindowsEdition -Online -ErrorAction Stop).Edition
$installationType = [string](Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name InstallationType -ErrorAction Stop)
@{ protocol = 'devbridge/windows-production-qualification-v1'; os = [string]$system.Version; build = [string]$system.BuildNumber; edition = $edition; architecture = ([string]$env:PROCESSOR_ARCHITECTURE).ToLowerInvariant(); installationType = $installationType; language = [Globalization.CultureInfo]::CurrentCulture.Name; bootIdentity = $bootIdentity; node = $node; npm = $npm; sourceControl = $git; nativeBuild = [string]$nativeBuild; cmake = $cmake; compiler = $compiler; authorityGeneration = [string]$manifest.authority.generation; payloadGeneration = [string]$manifest.payload.generation; network = $true; cmakeCtest = $true; services = $true } | ConvertTo-Json -Compress
`;

const RESTART_BODY = String.raw`
$ErrorActionPreference = 'Stop'
$process = Start-Process -FilePath 'shutdown.exe' -ArgumentList '/r', '/t', '5', '/f' -Wait -NoNewWindow -PassThru
if ($process.ExitCode -ne 0) { throw 'restart scheduling failed' }
@{ scheduled = $true } | ConvertTo-Json -Compress
`;

const FINALIZE_BODY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$root = 'C:\ProgramData\DevBridge'
foreach ($target in @(
  (Join-Path $root 'ImageConstruction'),
  (Join-Path $root 'access\seed.json'),
  (Join-Path $root 'access\state.json'),
  (Join-Path $root 'bootstrap\network-seed.json'),
  (Join-Path $root 'bootstrap\network-state.json'),
  (Join-Path $root 'bootstrap\state.json'),
  (Join-Path $root 'workspaces'),
  'C:\Windows\Panther\Unattend.xml',
  'C:\Windows\Panther\unattend.xml',
  'C:\Windows\Panther\Unattend'
)) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
Remove-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name DefaultPassword,AutoAdminLogon,DefaultUserName -ErrorAction SilentlyContinue
$administrator = Get-LocalUser | Where-Object { ([string]$_.SID).EndsWith('-500') } | Select-Object -First 1
if ($null -eq $administrator) { throw 'built-in construction account is unavailable' }
Disable-LocalUser -SID $administrator.SID -ErrorAction Stop
$sysprep = Join-Path $env:WINDIR 'System32\Sysprep\Sysprep.exe'
if (-not (Test-Path -LiteralPath $sysprep -PathType Leaf)) { throw 'system preparation executable is absent' }
$process = Start-Process -FilePath $sysprep -ArgumentList '/generalize', '/oobe', '/shutdown', '/mode:vm', '/quiet' -PassThru -WindowStyle Hidden
@{ scheduled = $true; processId = [int]$process.Id } | ConvertTo-Json -Compress
`;

export function createWindowsProductionOperations({ authority, payload } = {}) {
  const manifest = { authority: normalizeWindowsToolchainAuthority(authority), payload: normalizePayload(payload) };
  const header = manifestHeader(manifest);
  return Object.freeze({
    'prepare-v1': `${header}${PREPARE_BODY}`,
    'status-v1': STATUS_BODY,
    'qualify-v1': `${header}${QUALIFY_BODY}`,
    'restart-v1': RESTART_BODY,
    'finalize-v1': FINALIZE_BODY,
  });
}
