import { isIPv4 } from 'node:net';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore -ErrorAction Stop |
  Where-Object { [string]$_.State -eq 'Alive' } |
  Sort-Object @{ Expression = { [long]$_.RouteMetric + [long]$_.InterfaceMetric } }, InterfaceIndex |
  Select-Object -First 32)
$observations = @($routes | ForEach-Object {
  $route = $_
  $servers = @(Get-DnsClientServerAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
    ForEach-Object { $_.ServerAddresses } | Select-Object -First 16)
  @{ interfaceIndex = [int]$route.InterfaceIndex; servers = $servers }
})
@{ routes = $observations } | ConvertTo-Json -Depth 5 -Compress
`;

export function guestDnsServers(values) {
  if (!Array.isArray(values) || values.length > 64) throw new TypeError('guest DNS server observation is invalid');
  const servers = values.filter((value) => {
    if (typeof value !== 'string' || !isIPv4(value)) return false;
    const [first, second] = value.split('.').map(Number);
    return first !== 0 && first !== 127 && first < 224 && !(first === 169 && second === 254);
  });
  return Object.freeze([...new Set(servers)].slice(0, 4));
}

// A host-local resolver (including Node's 127.0.0.1 fallback) is not a guest
// resolver. Inherit configured DNS from the active Windows route, without
// inventing a public DNS policy or changing host networking.
export async function observeWindowsGuestDns({ invoke }) {
  const result = await invoke({ executable: 'powershell.exe',
    arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    input: null, timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
  if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
    throw new Error(`Windows guest DNS observation failed: ${String(result?.stderr || 'native observation unavailable').trim().slice(0, 1024)}`);
  }
  const observation = JSON.parse(result.stdout);
  if (!Array.isArray(observation?.routes) || observation.routes.length > 32) throw new Error('Windows guest DNS route observation is invalid');
  for (const route of observation.routes) {
    if (!Number.isSafeInteger(route?.interfaceIndex) || route.interfaceIndex < 1) throw new Error('Windows guest DNS interface observation is invalid');
    const servers = guestDnsServers(route.servers);
    if (servers.length) return servers;
  }
  throw new Error('Windows has no guest-reachable DNS configured on an active default route');
}
