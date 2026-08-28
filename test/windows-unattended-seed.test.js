import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsUnattendedSeed } from '../src/runtime/image-builders/windows-unattended-seed.js';
import { invokeCommand } from '../src/runtime/command-invocation.js';

function request(overrides = {}) {
  return {
    identity: 'subject-0123456789abcdef0123456789abcdef',
    image: { index: 6, architecture: 'amd64', defaultLanguage: 'en-US' },
    access: { user: 'Administrator', secret: 'A<&"strong temporary secret 42!' },
    ...overrides,
  };
}

test('Windows unattended seed binds exact image selection and reaches one-time Audit Mode handoff', () => {
  const result = createWindowsUnattendedSeed(request());
  assert.equal(result.protocol, 'devbridge/windows-unattended-seed-v1');
  assert.deepEqual(result.files.map((entry) => entry.path), ['Autounattend.xml', 'Setup/Prepare.ps1']);
  const answer = result.files[0].content;
  const prepare = result.files[1].content;
  assert.match(answer, /<Key>\/IMAGE\/INDEX<\/Key>\s*<Value>6<\/Value>/u);
  assert.match(answer, /processorArchitecture="amd64"/u);
  assert.match(answer, /<UILanguage>en-US<\/UILanguage>/u);
  assert.match(answer, /<WillWipeDisk>true<\/WillWipeDisk>/u);
  assert.match(answer, /<Type>EFI<\/Type>/u);
  assert.match(answer, /<Type>MSR<\/Type>/u);
  assert.match(answer, /<Mode>Audit<\/Mode>/u);
  assert.match(answer, /<WillShowUI>Never<\/WillShowUI>/u);
  assert.match(answer, /Get-Volume -FileSystemLabel &apos;DB_SETUP&apos;/u);
  assert.match(answer, /A&lt;&amp;&quot;strong temporary secret 42!/u);
  assert.match(prepare, /shutdown\.exe' -ArgumentList '\/s', '\/t', '10', '\/f'/u);
  assert.ok(prepare.indexOf("Start-Process -FilePath 'shutdown.exe'") < prepare.indexOf('Move-Item -LiteralPath $pending -Destination $ready'));
  assert.match(prepare, /if \(Test-Path -LiteralPath \$ready -PathType Leaf\) \{ exit 0 \}/u);
  assert.equal(JSON.stringify(result.evidence).includes(request().access.secret), false);
  assert.match(result.evidence.sha256, /^[a-f0-9]{64}$/u);
});

test('Windows unattended seed rejects authority-shaped, unsupported, and ambiguous inputs', () => {
  assert.throws(() => createWindowsUnattendedSeed({ ...request(), mediaAuthority: {} }), /mediaAuthority is not allowed/u);
  assert.throws(() => createWindowsUnattendedSeed(request({ image: { index: 6, architecture: 'arm64', defaultLanguage: 'en-US' } })), /architecture is unsupported/u);
  assert.throws(() => createWindowsUnattendedSeed(request({ access: { user: 'someone', secret: 'A strong temporary secret 42!' } })), /access user is unsupported/u);
  assert.throws(() => createWindowsUnattendedSeed(request({ access: { user: 'Administrator', secret: 'short' } })), /access secret is invalid/u);
  assert.throws(() => createWindowsUnattendedSeed(request({ image: { index: 0, architecture: 'amd64', defaultLanguage: 'en-US' } })), /image index is invalid/u);
});

test('Windows unattended seed stays isolated from provider and repository topology', () => {
  const text = createWindowsUnattendedSeed(request()).files.map((entry) => entry.content).join('\n');
  assert.doesNotMatch(text, /Hyper-V|libvirt|GitHub|repository|branch|pull request|VMName/iu);
});

test('Windows unattended answer is accepted by the host XML parser without interactive input', { skip: process.platform !== 'win32' }, async () => {
  const answer = createWindowsUnattendedSeed(request()).files[0].content;
  const script = "$ErrorActionPreference='Stop'; [xml]$document=[Console]::In.ReadToEnd(); @{ root = [string]$document.DocumentElement.LocalName } | ConvertTo-Json -Compress";
  const result = await invokeCommand({
    executable: 'powershell.exe',
    arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    input: answer,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { root: 'unattend' });
});
