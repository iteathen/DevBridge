import test from 'node:test';
import assert from 'node:assert/strict';
import { guestDnsServers, observeWindowsGuestDns } from '../src/runtime/providers/windows-guest-dns.js';

test('guest DNS excludes host-local and non-unicast addresses and keeps configured order', () => {
  assert.deepEqual(guestDnsServers(['127.0.0.1', '127.1.2.3', '0.0.0.0', '169.254.1.1', '224.0.0.1', '255.255.255.255', '::1', 'bad', '192.168.1.1', '10.0.0.53', '192.168.1.1']), ['192.168.1.1', '10.0.0.53']);
  assert.throws(() => guestDnsServers('8.8.8.8'), /observation/u);
  assert.throws(() => guestDnsServers(Array(65).fill('8.8.8.8')), /observation/u);
});

test('Windows guest DNS inherits the first usable active route and never invents a resolver', async () => {
  const invoke = async (request) => {
    assert.equal(request.executable, 'powershell.exe');
    assert.equal(request.input, null);
    assert.ok(request.timeoutMs <= 15_000);
    return { exitCode: 0, stdout: JSON.stringify({ routes: [
      { interfaceIndex: 1, servers: ['127.0.0.1'] },
      { interfaceIndex: 2, servers: ['192.168.1.1'] },
      { interfaceIndex: 3, servers: ['8.8.8.8'] },
    ] }) };
  };
  assert.deepEqual(await observeWindowsGuestDns({ invoke }), ['192.168.1.1']);
  for (const routes of [[], [{ interfaceIndex: 1, servers: ['127.0.0.1'] }]]) {
    await assert.rejects(observeWindowsGuestDns({ invoke: async () => ({ exitCode: 0, stdout: JSON.stringify({ routes }) }) }), /no guest-reachable DNS/u);
  }
  for (const result of [{ exitCode: 1, stderr: 'native failed' }, { exitCode: 0, timedOut: true }, { exitCode: 0, outputTruncated: true }]) {
    await assert.rejects(observeWindowsGuestDns({ invoke: async () => result }), /observation failed/u);
  }
});
