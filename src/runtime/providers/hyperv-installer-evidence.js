import { createHash } from 'node:crypto';
import path from 'node:path';
import { decodeInstallerEvidence, INSTALLER_EVIDENCE_MAX_BYTES } from '../construction-install-evidence.js';

const TOKEN = /^[a-f0-9]{32}$/u;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SPECIAL_VM_IDS = new Set([
  '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '90db8b89-0d35-4f79-8ce9-49ea0ac8b7cd', 'e0e16197-dd56-4a10-9195-5ee7a155a838',
  'a42e7cda-d03f-480c-9cc2-a4de20abb878',
]);

// The host is the client; the live installer listens on its VSOCK port.
// Registry registration for guest connections to a host listener does not
// belong to this direction. Availability comes from the exact socket exchange.
const READ = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
Import-Module Hyper-V -ErrorAction Stop
$machine = Get-VM -Id ([guid]$data.vmId) -ErrorAction Stop
if ([guid]$machine.Id -ne [guid]$data.vmId -or [string]$machine.Name -cne [string]$data.name -or [string]$machine.Notes -cne [string]$data.marker -or [int]$machine.Generation -ne 2 -or [string]$machine.State -ne 'Running') {
  throw 'installer evidence machine attachment changed'
}
$media = @(Get-VMDvdDrive -VM $machine -ErrorAction Stop | Where-Object { [StringComparer]::OrdinalIgnoreCase.Equals([string]$_.Path, [string]$data.seedPath) })
if ($media.Count -ne 1) { throw 'installer evidence seed is not attached to the exact machine' }
$seed = Get-Item -LiteralPath ([string]$data.seedPath) -ErrorAction Stop
if ($seed.PSIsContainer -or ($seed.Attributes -band [IO.FileAttributes]::ReparsePoint) -or [long]$seed.Length -ne [long]$data.seedBytes) { throw 'installer evidence seed file identity changed' }
$seedStream = [IO.File]::OpenRead([string]$data.seedPath)
try {
  if ($seedStream.Length -ne [long]$data.seedBytes) { throw 'installer evidence seed file identity changed' }
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $seedHash = [BitConverter]::ToString($algorithm.ComputeHash($seedStream)).Replace('-', '') }
  finally { $algorithm.Dispose() }
} finally { $seedStream.Dispose() }
if ($seedHash -ine [string]$data.seedSha256) { throw 'installer evidence seed bytes changed' }
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;

public sealed class DevBridgeInstallerEndpoint : EndPoint {
    private readonly Guid machine;
    private readonly Guid service;
    public DevBridgeInstallerEndpoint(Guid machine, Guid service) { this.machine = machine; this.service = service; }
    public override AddressFamily AddressFamily { get { return (AddressFamily)34; } }
    public override SocketAddress Serialize() {
        SocketAddress address = new SocketAddress(AddressFamily, 36);
        byte[] machineBytes = machine.ToByteArray();
        byte[] serviceBytes = service.ToByteArray();
        for (int index = 0; index < 16; index++) { address[index + 4] = machineBytes[index]; address[index + 20] = serviceBytes[index]; }
        return address;
    }
}

public static class DevBridgeInstallerSocket {
    private static void Wait(Socket socket, Stopwatch clock, int limit, SelectMode mode) {
        while (true) {
            long remaining = limit - clock.ElapsedMilliseconds;
            if (remaining <= 0) throw new TimeoutException("installer evidence socket deadline expired");
            if (socket.Poll((int)Math.Min(remaining * 1000, 100000), mode)) return;
        }
    }
    public static byte[] Read(Guid machine, Guid service, bool diagnostics) {
        int maximum = diagnostics ? 65536 : 4096;
        int deadline = diagnostics ? 15000 : 5000;
        Stopwatch clock = Stopwatch.StartNew();
        using (Socket socket = new Socket((AddressFamily)34, SocketType.Stream, (ProtocolType)1)) {
            socket.Blocking = false;
            try { socket.Connect(new DevBridgeInstallerEndpoint(machine, service)); }
            catch (SocketException error) {
                if (error.SocketErrorCode != SocketError.WouldBlock && error.SocketErrorCode != SocketError.InProgress && error.SocketErrorCode != SocketError.AlreadyInProgress) throw;
                Wait(socket, clock, Math.Min(deadline, 2000), SelectMode.SelectWrite);
                int status = (int)socket.GetSocketOption(SocketOptionLevel.Socket, SocketOptionName.Error);
                if (status != 0) throw new SocketException(status);
            }
            byte[] selector = new byte[] { diagnostics ? (byte)68 : (byte)83 };
            while (true) {
                Wait(socket, clock, deadline, SelectMode.SelectWrite);
                try { if (socket.Send(selector) != 1) throw new IOException("installer evidence request was incomplete"); break; }
                catch (SocketException error) { if (error.SocketErrorCode != SocketError.WouldBlock) throw; }
            }
            socket.Shutdown(SocketShutdown.Send);
            using (MemoryStream result = new MemoryStream()) {
                byte[] chunk = new byte[4096];
                while (true) {
                    Wait(socket, clock, deadline, SelectMode.SelectRead);
                    int count;
                    try { count = socket.Receive(chunk, 0, Math.Min(chunk.Length, maximum + 1 - (int)result.Length), SocketFlags.None); }
                    catch (SocketException error) { if (error.SocketErrorCode == SocketError.WouldBlock) continue; throw; }
                    if (count == 0) {
                        if (result.Length == 0) throw new IOException("installer evidence response was empty");
                        return result.ToArray();
                    }
                    if (result.Length + count > maximum) throw new IOException("installer evidence response exceeded its byte limit");
                    result.Write(chunk, 0, count);
                }
            }
        }
    }
}
'@
$bytes = [DevBridgeInstallerSocket]::Read([guid]$data.vmId, [guid]$data.serviceId, [bool]$data.diagnostics)
@{ available = $true; bytesBase64 = [Convert]::ToBase64String($bytes) } | ConvertTo-Json -Compress
`;

export function hyperVInstallerEvidenceService(identity) {
  if (typeof identity !== 'string' || !TOKEN.test(identity)) throw new TypeError('installer evidence installation identity is invalid');
  // Derive a stable installation-specific service/guest port. Exact VM and
  // seed attachment checks below isolate the endpoint; exclude reserved ports.
  const suffix = createHash('sha256').update(`devbridge:installer-evidence-v1:${identity}`).digest('hex').slice(0, 7);
  const guestPort = 0x40000000 + Number.parseInt(suffix, 16);
  const serviceId = `${guestPort.toString(16).padStart(8, '0')}-facb-11e6-bd58-64006a7986d3`;
  return Object.freeze({ guestPort, serviceId });
}

export function createHyperVInstallerEvidence({ identity, invoke }) {
  if (typeof invoke !== 'function') throw new TypeError('installer evidence provider ports are invalid');
  const { guestPort, serviceId } = hyperVInstallerEvidenceService(identity);
  const read = async ({ binding, attachment, sequence = null }, diagnostics) => {
    if (!binding || !attachment || !GUID.test(binding.providerInstance) || SPECIAL_VM_IDS.has(binding.providerInstance)
        || attachment.providerIdentity !== binding.providerInstance
        || typeof attachment.name !== 'string' || !/^db-image-build-[a-f0-9]{16}$/u.test(attachment.name)
        || attachment.marker !== `devbridge-owned:${identity}:image-build:${binding.subject}:v1`
        || typeof binding.subject !== 'string' || !/^subject-[a-f0-9]{32}$/u.test(binding.subject)
        || typeof binding.seedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.seedSha256)
        || attachment.seed?.sha256 !== binding.seedSha256 || !Number.isSafeInteger(attachment.seed?.bytes) || attachment.seed.bytes < 1
        || typeof attachment.seed?.location !== 'string' || attachment.seed.location.includes('\0') || !path.win32.isAbsolute(attachment.seed.location)
        || (diagnostics && (!Number.isSafeInteger(sequence) || sequence < 1))) throw new TypeError('installer evidence attachment is invalid');
    const result = await invoke({
      executable: 'powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(READ, 'utf16le').toString('base64')],
      input: JSON.stringify({ serviceId, vmId: binding.providerInstance, name: attachment.name, marker: attachment.marker, diagnostics, seedPath: attachment.seed.location, seedBytes: attachment.seed.bytes, seedSha256: binding.seedSha256 }),
      timeoutMs: 30_000, maxOutputBytes: 128 * 1024,
    });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) return { status: 'unavailable', reason: 'installer evidence native attachment or collection failed' };
    let value;
    try { value = JSON.parse(result.stdout); } catch { throw new Error('installer evidence transport response is invalid'); }
    const maximum = diagnostics ? INSTALLER_EVIDENCE_MAX_BYTES : 4096;
    if (value?.available !== true || Object.keys(value).length !== 2 || typeof value.bytesBase64 !== 'string'
        || value.bytesBase64.length > Math.ceil(maximum / 3) * 4) throw new Error('installer evidence transport response is invalid');
    const bytes = Buffer.from(value.bytesBase64, 'base64');
    if (bytes.toString('base64') !== value.bytesBase64 || bytes.length > maximum) throw new Error('installer evidence transport response is outside bounds');
    const report = decodeInstallerEvidence(bytes, binding);
    if (diagnostics && report.sequence !== sequence) throw new Error('installer diagnostic outcome sequence changed');
    return { status: 'available', bytes };
  };
  return Object.freeze({
    guestPort, serviceId,
    read: request => read(request, false),
    readDiagnostics: request => read(request, true),
  });
}
