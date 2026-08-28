import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeCommand } from '../src/runtime/command-invocation.js';
import { createWindowsSetupResourceConflict } from '../src/setup/windows-resource-conflict.js';

const IDENTITY = 'a'.repeat(32);

function encoded(value) {
  return Buffer.from(value, 'utf16le').toString('base64');
}

function success(value) {
  return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
}

async function withMocks(request, mocks) {
  const script = Buffer.from(request.arguments.at(-1), 'base64').toString('utf16le');
  return invokeCommand({
    ...request,
    arguments: [...request.arguments.slice(0, -1), encoded(`${mocks}\n${script}`)],
  });
}

const SAFE_FOREIGN = String.raw`
function Import-Module { [CmdletBinding()] param([Parameter(Position=0)]$Name) }
$script:removed = $false
function Get-NetNat { [CmdletBinding()] param([string]$Name) if ($script:removed) { @() } else { @([pscustomobject]@{ Name = 'inactive-local'; InternalIPInterfaceAddressPrefix = '10.77.0.0/24' }) } }
function Get-VMSwitch { [CmdletBinding()] param() @([pscustomobject]@{ Name = 'inactive-local'; Id = [guid]'11111111-2222-4333-8444-555555555555'; SwitchType = 'Internal'; Notes = '' }) }
function Get-NetNatStaticMapping { [CmdletBinding()] param([string]$NatName) @() }
function Get-NetNatSession { [CmdletBinding()] param() @() }
function Get-VMNetworkAdapter { [CmdletBinding()] param([string]$VMName) @() }
function Remove-NetNat { [CmdletBinding()] param([string]$Name, [switch]$Confirm) $script:removed = $true }
`;

test('Windows conflict inspection returns an opaque subject without exposing provider identities', { skip: process.platform !== 'win32' }, async () => {
  const adapter = createWindowsSetupResourceConflict({
    identity: IDENTITY,
    platform: 'win32',
    invoke: (request) => withMocks(request, SAFE_FOREIGN),
  });
  const observed = await adapter.inspect();
  assert.equal(observed.state, 'approval-required');
  assert.match(observed.subject, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(observed).includes('inactive-local'), false);
  assert.equal(Object.hasOwn(observed, 'name'), false);
});

test('Windows retirement re-observes and removes only the exact approved inactive subject', { skip: process.platform !== 'win32' }, async () => {
  const adapter = createWindowsSetupResourceConflict({
    identity: IDENTITY,
    platform: 'win32',
    invoke: (request) => withMocks(request, SAFE_FOREIGN),
  });
  const observed = await adapter.inspect();
  assert.deepEqual(await adapter.retire({ protocol: 'devbridge/setup-resource-conflict-consent-v1', subject: observed.subject }), {
    protocol: 'devbridge/setup-resource-conflict-retirement-v1',
    ready: true,
    changed: true,
    reason: null,
  });
  const changed = await adapter.retire({ protocol: 'devbridge/setup-resource-conflict-consent-v1', subject: 'f'.repeat(64) });
  assert.equal(changed.ready, false);
  assert.equal(changed.changed, false);
  assert.match(changed.reason, /subject changed/u);
});

test('Windows conflict retirement refuses active dependants before exposing a consent subject', { skip: process.platform !== 'win32' }, async () => {
  const mocks = SAFE_FOREIGN.replace(
    'function Get-NetNatStaticMapping { [CmdletBinding()] param([string]$NatName) @() }',
    "function Get-NetNatStaticMapping { [CmdletBinding()] param([string]$NatName) @([pscustomobject]@{ Active = $true }) }",
  );
  const adapter = createWindowsSetupResourceConflict({ identity: IDENTITY, platform: 'win32', invoke: (request) => withMocks(request, mocks) });
  const observed = await adapter.inspect();
  assert.equal(observed.state, 'blocked');
  assert.equal(observed.subject, null);
  assert.match(observed.reason, /active dependants/u);
});

for (const [kind, original, replacement] of [
  [
    'session',
    'function Get-NetNatSession { [CmdletBinding()] param() @() }',
    "function Get-NetNatSession { [CmdletBinding()] param() @([pscustomobject]@{ NatName = 'inactive-local' }) }",
  ],
  [
    'guest adapter',
    'function Get-VMNetworkAdapter { [CmdletBinding()] param([string]$VMName) @() }',
    "function Get-VMNetworkAdapter { [CmdletBinding()] param([string]$VMName) @([pscustomobject]@{ SwitchId = [guid]'11111111-2222-4333-8444-555555555555' }) }",
  ],
]) {
  test(`Windows conflict retirement refuses an active ${kind} before exposing a consent subject`, { skip: process.platform !== 'win32' }, async () => {
    const mocks = SAFE_FOREIGN.replace(original, replacement);
    const adapter = createWindowsSetupResourceConflict({ identity: IDENTITY, platform: 'win32', invoke: (request) => withMocks(request, mocks) });
    const observed = await adapter.inspect();
    assert.equal(observed.state, 'blocked');
    assert.equal(observed.subject, null);
    assert.match(observed.reason, /active dependants/u);
  });
}

test('Windows retirement does not invoke removal after the approved subject changes', { skip: process.platform !== 'win32' }, async () => {
  const mocks = SAFE_FOREIGN.replace(
    'function Remove-NetNat { [CmdletBinding()] param([string]$Name, [switch]$Confirm) $script:removed = $true }',
    "function Remove-NetNat { [CmdletBinding()] param([string]$Name, [switch]$Confirm) throw 'removal must not run' }",
  );
  const adapter = createWindowsSetupResourceConflict({ identity: IDENTITY, platform: 'win32', invoke: (request) => withMocks(request, mocks) });
  const changed = await adapter.retire({ protocol: 'devbridge/setup-resource-conflict-consent-v1', subject: 'f'.repeat(64) });
  assert.equal(changed.ready, false);
  assert.equal(changed.changed, false);
  assert.match(changed.reason, /subject changed/u);
});

test('Windows conflict inspection treats the exact accepted owned translation as clear', { skip: process.platform !== 'win32' }, async () => {
  const mocks = String.raw`
function Import-Module { [CmdletBinding()] param([Parameter(Position=0)]$Name) }
function Get-NetNat { [CmdletBinding()] param() @([pscustomobject]@{ Name = [string]$data.expected.name; InternalIPInterfaceAddressPrefix = [string]$data.expected.prefix }) }
function Get-VMSwitch { [CmdletBinding()] param() @([pscustomobject]@{ Name = [string]$data.expected.name; Id = [guid]'11111111-2222-4333-8444-555555555555'; SwitchType = 'Internal'; Notes = [string]$data.expected.marker }) }
`;
  const adapter = createWindowsSetupResourceConflict({ identity: IDENTITY, platform: 'win32', invoke: (request) => withMocks(request, mocks) });
  assert.deepEqual(await adapter.inspect(), {
    protocol: 'devbridge/setup-resource-conflict-v1',
    state: 'clear',
    subject: null,
    reason: null,
  });
});

test('Windows conflict adapter fails closed on invalid subprocess evidence', async () => {
  const adapter = createWindowsSetupResourceConflict({ identity: IDENTITY, platform: 'win32', invoke: async () => success({ state: 'approval-required', subject: 'bad', reason: 'bad' }) });
  await assert.rejects(adapter.inspect(), /subject is invalid/u);
});
