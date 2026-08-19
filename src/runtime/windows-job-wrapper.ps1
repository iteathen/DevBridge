param(
  [Parameter(Mandatory = $true)]
  [string]$Executable,

  [Parameter(Mandatory = $true)]
  [string]$ArgumentsBase64
)

$ErrorActionPreference = 'Stop'

if ($Executable.Contains('"')) {
  throw 'Windows ProcessContainer executable path contains an invalid quote character'
}

$launcher = Join-Path (Split-Path -Parent $Executable) 'devbridge-job-launcher.exe'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "DevBridge Windows job launcher is missing: $launcher"
}

$arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))
$commandLine = '"' + $Executable + '"'
if ($arguments.Length -gt 0) {
  $commandLine += ' ' + $arguments
}
$commandLineBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($commandLine))

& $launcher --executable $Executable --command-line-base64 $commandLineBase64
exit $LASTEXITCODE
