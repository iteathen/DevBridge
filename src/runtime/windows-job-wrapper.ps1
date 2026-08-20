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

$arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))

# MXC 0.7 creates the actual AppContainer child inside its own UI Job Object,
# so an ancestor Job Object around wxc-exec does not own that sandbox process.
# DevBridge therefore launches MXC directly and performs authoritative cleanup
# afterward by the unique AppContainer SID. ProcessStartInfo with
# UseShellExecute=false preserves this PowerShell process's standard streams
# unless they are explicitly redirected, which keeps the caller's live stdin,
# stdout, and stderr path intact without adding a second buffering relay.
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $Executable
$startInfo.Arguments = $arguments
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WorkingDirectory = (Get-Location).Path

$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
try {
  if (-not $process.Start()) {
    throw 'Windows ProcessContainer executable did not start'
  }
  $process.WaitForExit()
  $exitCode = $process.ExitCode
} finally {
  $process.Dispose()
}

exit $exitCode
