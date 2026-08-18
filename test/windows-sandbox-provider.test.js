import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionSandboxProvider } from '../src/runtime/sandbox-provider.js';
import { WindowsSandboxProvider, windowsSandboxInternalsForTests } from '../src/runtime/windows-sandbox-provider.js';

const { configurationXml, parseSandboxId } = windowsSandboxInternalsForTests;

test('Windows Sandbox configuration disables ambient host channels and maps explicit folders with intended write policy', () => {
  const xml = configurationXml([
    { host: 'C:\\worker', sandbox: 'C:\\PatchPoller\\w0', writable: true },
    { host: 'C:\\toolchain', sandbox: 'C:\\PatchPoller\\r1', writable: false },
  ]);
  assert.match(xml, /<Networking>Disable<\/Networking>/u);
  assert.match(xml, /<ClipboardRedirection>Disable<\/ClipboardRedirection>/u);
  assert.match(xml, /<VGpu>Disable<\/VGpu>/u);
  assert.match(xml, /<ProtectedClient>Enable<\/ProtectedClient>/u);
  assert.match(xml, /<HostFolder>C:\\worker<\/HostFolder>/u);
  assert.match(xml, /<ReadOnly>false<\/ReadOnly>/u);
  assert.match(xml, /<HostFolder>C:\\toolchain<\/HostFolder>/u);
  assert.match(xml, /<ReadOnly>true<\/ReadOnly>/u);
});

test('Windows Sandbox raw output parser accepts nested JSON and rejects output without a sandbox ID', () => {
  const id = '12345678-1234-1234-1234-1234567890ab';
  assert.equal(parseSandboxId(JSON.stringify({ value: { sandboxId: id } })), id);
  assert.equal(parseSandboxId(`started ${id}`), id);
  assert.equal(parseSandboxId('{"status":"running"}'), null);
});

test('Windows Sandbox provider stays explicitly unverified on unsupported hosts rather than silently degrading', async () => {
  const provider = new WindowsSandboxProvider();
  if (process.platform !== 'win32') {
    const status = await provider.verify();
    assert.equal(status.verified, false);
    assert.equal(status.provider, 'windows-sandbox');
    assert.match(status.reason, /not supported/u);
  } else {
    assert.equal(provider.status().verified, false);
  }
});

test('sandbox factory selects the platform provider only from local configuration', () => {
  assert.equal(createExecutionSandboxProvider({ provider: 'none' }), null);
  const explicit = createExecutionSandboxProvider({ provider: 'windows-sandbox' });
  assert.equal(explicit.name, 'windows-sandbox');
});
