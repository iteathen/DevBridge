import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CORE = new URL('../src/runtime/environment-configuration-authority.js', import.meta.url);
const TRANSPORT = new URL('../src/runtime/environment-configuration-authority-transport.js', import.meta.url);
const RECORD = new URL('../src/setup/environment-profile-configuration-record.js', import.meta.url);
const ORDINARY = new URL('../src/setup/windows-environment-profile-configuration.js', import.meta.url);
const TOPOLOGY = new URL('../src/app/windows-environment-configuration-host.js', import.meta.url);

test('configuration contract remains topology- and provider-agnostic', async () => {
  const source = await readFile(CORE, 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:app|setup|providers|github|guest)[^'"]*['"]/iu);
  assert.doesNotMatch(source, /\b(?:windows|linux|hyper-v|libvirt|provider|virtualMachine|repository|vhdx|qcow2|powershell|systemd)\b/iu);
});

test('configuration transport owns framing and endpoint mechanics but no topology or provider composition', async () => {
  const source = await readFile(TRANSPORT, 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:app|setup|providers|github|guest)[^'"]*['"]/iu);
  assert.doesNotMatch(source, /\b(?:hyper-v|libvirt|provider|virtualMachine|repository|vhdx|qcow2|powershell|systemd)\b/iu);
});

test('accepted-record reader owns only bounded local record observation', async () => {
  const source = await readFile(RECORD, 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:app|providers|github|guest)[^'"]*['"]/iu);
  assert.doesNotMatch(source, /\b(?:hyper-v|libvirt|provider|virtualMachine|repository|vhdx|qcow2|powershell|systemd)\b/iu);
});

test('ordinary configuration proxy cannot select protected mechanics or physical identities', async () => {
  const source = await readFile(ORDINARY, 'utf8');
  assert.doesNotMatch(source, /environment-foundation|environment-lifecycle|image-adoption|resource-conflict|command-invocation|providers\//iu);
  assert.doesNotMatch(source, /\b(?:hyper-v|libvirt|provider|virtualMachine|vmName|imagePath|protectedRoot|executable|credential|powershell|systemd)\b/iu);
});

test('provider mechanics are attached only at the protected topology edge', async () => {
  const source = await readFile(TOPOLOGY, 'utf8');
  assert.match(source, /createEnvironmentFoundation/u);
  assert.match(source, /createEnvironmentLifecycle/u);
  assert.match(source, /reconcileWindowsLifecycleAuthorityImages/u);
  assert.doesNotMatch(source, /createConfiguredEnvironmentConfigurationClient|createEnvironmentConfigurationSocketExchange/u);
});
