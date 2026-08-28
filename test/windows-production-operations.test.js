import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultWindowsToolchainAuthority } from '../src/setup/windows-toolchain-authority.js';
import { createWindowsGuestImagePayload } from '../src/guest/windows-image-payload.js';
import { createWindowsProductionOperations } from '../src/runtime/image-builders/windows-production-operations.js';
import { invokeCommand } from '../src/runtime/command-invocation.js';

test('Windows production operations bind exact tool and payload authorities into local registered code', async () => {
  const authority = createDefaultWindowsToolchainAuthority();
  const payload = await createWindowsGuestImagePayload();
  const operations = createWindowsProductionOperations({ authority, payload });
  assert.deepEqual(Object.keys(operations), ['prepare-v1', 'status-v1', 'qualify-v1', 'restart-v1', 'finalize-v1']);
  const prepare = operations['prepare-v1'];
  assert.match(prepare, /Invoke-WebRequest/u);
  assert.match(prepare, /Get-FileHash/u);
  assert.match(prepare, /Microsoft\.VisualStudio\.Workload\.VCTools/u);
  assert.match(prepare, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/u);
  assert.match(prepare, /Microsoft\.VisualStudio\.Component\.VC\.CMake\.Project/u);
  assert.match(prepare, /Microsoft\.VisualStudio\.Component\.Windows11SDK\.26100/u);
  assert.match(prepare, /--noUpdateInstaller/u);
  assert.doesNotMatch(prepare, /--includeRecommended/u);
  assert.match(prepare, /installationVersion/u);
  assert.match(prepare, /msiexec\.exe/u);
  assert.match(prepare, /DevBridgeAccessSeed/u);
  assert.match(prepare, /DevBridgeNetworkSeed/u);
  assert.match(prepare, /S-1-5-32-545/u);
  assert.match(prepare, /S-1-5-32-544/u);
  assert.match(prepare, /bootIdentity/u);
  const encodedManifest = /\$manifestBase64 = '([^']+)'/u.exec(prepare)?.[1];
  assert.equal(typeof encodedManifest, 'string');
  const boundManifest = JSON.parse(Buffer.from(encodedManifest, 'base64').toString('utf8'));
  assert.deepEqual(boundManifest.authority, authority);
  assert.equal(boundManifest.payload.generation, payload.generation);
  assert.equal(prepare.includes(payload.files[0].content), false, 'payload source must remain base64-bound rather than interpolated');
  const qualify = operations['qualify-v1'];
  assert.match(qualify, /Resolve-DnsName/u);
  assert.match(qualify, /Invoke-WebRequest/u);
  assert.match(qualify, /CMakeLists\.txt/u);
  assert.match(qualify, /main\.c/u);
  assert.match(qualify, /ctest\.exe/u);
  assert.match(qualify, /Get-WindowsEdition/u);
  assert.match(qualify, /authorityGeneration/u);
  assert.match(qualify, /nativeBuild/u);
  assert.match(operations['status-v1'], /LastBootUpTime/u);
  const finalize = operations['finalize-v1'];
  assert.match(finalize, /Sysprep\.exe/u);
  assert.match(finalize, /\/generalize/u);
  assert.match(finalize, /\/oobe/u);
  assert.match(finalize, /\/shutdown/u);
  assert.match(finalize, /\/mode:vm/u);
  assert.match(finalize, /Disable-LocalUser/u);
  assert.match(finalize, /Panther/u);
  assert.doesNotMatch(Object.values(operations).join('\n'), /Hyper-V|libvirt|GitHub|repository|branch|pull request|product.?key|CUDA/iu);
});

test('Windows production operations are syntactically accepted by Windows PowerShell without execution', { skip: process.platform !== 'win32' }, async () => {
  const operations = createWindowsProductionOperations({ authority: createDefaultWindowsToolchainAuthority(), payload: await createWindowsGuestImagePayload() });
  const parser = "$ErrorActionPreference='Stop'; $source=[Console]::In.ReadToEnd(); $null=[ScriptBlock]::Create($source); @{ valid=$true } | ConvertTo-Json -Compress";
  for (const [identity, source] of Object.entries(operations)) {
    const result = await invokeCommand({
      executable: 'powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')],
      input: source,
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
    });
    assert.equal(result.exitCode, 0, `${identity}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { valid: true });
  }
});

test('Windows production operations reject malformed payload authority before code generation', async () => {
  const authority = createDefaultWindowsToolchainAuthority();
  const payload = await createWindowsGuestImagePayload();
  assert.throws(() => createWindowsProductionOperations({ authority, payload: { ...payload, files: [{ ...payload.files[0], sha256: '0'.repeat(64) }] } }), /digest does not match/u);
  assert.throws(() => createWindowsProductionOperations({ authority: { ...authority, command: 'anything' }, payload }), /command is not allowed/u);
});
