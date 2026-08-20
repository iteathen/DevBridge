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
# DevBridge performs authoritative cleanup afterward by the unique AppContainer
# SID. The Node -> PowerShell standard handles are not reliably inheritable by
# grandchildren, so explicitly relay all three streams instead of assuming
# CreateProcess-style inheritance will survive the extra process boundary.
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $Executable
$startInfo.Arguments = $arguments
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WorkingDirectory = (Get-Location).Path
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true

$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$parentInput = $null
$parentOutput = $null
$parentError = $null
$stdinTask = $null
$stdoutTask = $null
$stderrTask = $null
try {
  if (-not $process.Start()) {
    throw 'Windows ProcessContainer executable did not start'
  }

  $parentInput = [Console]::OpenStandardInput()
  $parentOutput = [Console]::OpenStandardOutput()
  $parentError = [Console]::OpenStandardError()

  # CopyToAsync works on the raw streams, avoiding PowerShell text/pipeline
  # re-encoding. The input relay is intentionally not awaited before process
  # exit: callers that provide stdin close it normally, while callers that do
  # not must not keep an otherwise-finished sandbox alive merely because the
  # parent stdin pipe remains open.
  $stdinTask = $parentInput.CopyToAsync($process.StandardInput.BaseStream)
  $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($parentOutput)
  $stderrTask = $process.StandardError.BaseStream.CopyToAsync($parentError)

  $process.WaitForExit()
  $exitCode = $process.ExitCode

  # A detached descendant can retain inherited output handles after wxc-exec
  # exits. Give already-produced bytes a bounded drain window, then close our
  # read ends rather than letting a background process hold DevBridge cleanup
  # indefinitely.
  $drainTask = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask))
  if (-not $drainTask.Wait(2000)) {
    $process.StandardOutput.Close()
    $process.StandardError.Close()
    if (-not $drainTask.Wait(500)) {
      throw 'Windows ProcessContainer output relay did not drain after process exit'
    }
  }

  $parentOutput.Flush()
  $parentError.Flush()
} finally {
  if ($process.StandardInput) { $process.StandardInput.Close() }
  if ($parentInput) { $parentInput.Dispose() }
  if ($process.StandardOutput) { $process.StandardOutput.Close() }
  if ($process.StandardError) { $process.StandardError.Close() }
  $process.Dispose()
}

exit $exitCode
