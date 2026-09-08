// Fixed adapter code, run inside the selected guest over its authenticated
// transport. It invokes only the installed bridge entrypoint; frames are stdin
// data. Each bridge request retains the guest agent's durable effect identity.
function linuxSession() {
  const { spawnSync } = require('node:child_process');
  let buffer = Buffer.alloc(0), target = null;
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 64 * 1024) process.exit(1);
    const end = buffer.indexOf(10);
    if (end < 0) return;
    if (end !== buffer.length - 1) process.exit(1);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)));
    buffer = Buffer.alloc(0);
    if (target == null) {
      if (!/^env-[a-f0-9]{32}$/.test(value.target) || Object.keys(value).length !== 1) process.exit(1);
      target = value.target;
      process.stdout.write('{"ready":true}\n');
      return;
    }
    if (value.target !== target) process.exit(1);
    const result = spawnSync('node', ['/usr/local/libexec/devbridge/bridge-agent.mjs', '--exchange-stdin'], {
      input: JSON.stringify(value), encoding: 'utf8', shell: false,
      timeout: 120000, maxBuffer: 7 * 1024 * 1024,
      env: { ...process.env, DEVBRIDGE_GUEST_TARGET: target },
    });
    if (result.error || result.status !== 0 || result.signal || result.stderr) process.exit(1);
    process.stdout.write(JSON.stringify(JSON.parse(result.stdout)) + '\n');
  });
  process.stdin.on('end', () => process.exit(buffer.length ? 1 : 0));
}

export const LINUX_BRIDGE_SESSION_COMMAND = `node -e 'eval(Buffer.from("${Buffer.from(`(${linuxSession.toString()})()`).toString('base64')}","base64").toString("utf8"))'`;

export const DIRECT_GUEST_SCRIPT = String.raw`
    param($encoded, $target)
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = 'node.exe'
    $start.Arguments = 'C:\ProgramData\DevBridge\bridge-agent.mjs --exchange-stdin'
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables['DEVBRIDGE_GUEST_TARGET'] = $target
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'bridge helper did not start' }
    $process.StandardInput.Write($json)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'bridge helper timed out' }
    if ($process.ExitCode -ne 0) { throw 'bridge helper exited unsuccessfully' }
    if ($stderr.Result.Length -ne 0 -or $stdout.Result.Length -gt 7340032) { throw 'bridge helper output is invalid' }
    $stdout.Result
`;

export const DIRECT_SESSION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$data = [Console]::ReadLine() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$item = Get-VM -Name ([string]$data.reference) -ErrorAction Stop
if ([string]$item.Notes -ne [string]$data.proof) { throw 'environment ownership proof does not match' }
if ([string]$item.State -ne 'Running') { throw 'environment is not running' }
$secure = [Security.SecureString]::new()
$session = $null
try {
  foreach ($character in ([string]$data.password).ToCharArray()) { $secure.AppendChar($character) }
  $secure.MakeReadOnly()
  $credential = [Management.Automation.PSCredential]::new([string]$data.username, $secure)
  $target = [string]$data.target
  $session = New-PSSession -VMId $item.Id -Credential $credential -ErrorAction Stop
  $data = $null
  [Console]::WriteLine('{"ready":true}')
  while ($null -ne ($line = [Console]::ReadLine())) {
    if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 65536) { throw 'bridge frame is too large' }
    $frame = $line | ConvertFrom-Json
    if ([string]$frame.target -ne $target) { throw 'bridge target changed' }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line))
    $output = Invoke-Command -Session $session -ArgumentList $encoded, $target -ScriptBlock {${DIRECT_GUEST_SCRIPT}} -ErrorAction Stop
    [Console]::WriteLine(([string]$output).Trim())
  }
} finally {
  if ($null -ne $session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
  $secure.Dispose()
}
`;
