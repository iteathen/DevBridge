import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SETUP_APP = new URL('../src/app/setup.js', import.meta.url);
const CLI = new URL('../src/cli.js', import.meta.url);
const PATH_VISIBILITY = new URL('../src/setup/path-visibility.js', import.meta.url);

test('generic setup composes observations and one explicit construction action through local apps', async () => {
  const source = await readFile(SETUP_APP, 'utf8');
  assert.doesNotMatch(source, /runtime\/providers\//u);
  assert.doesNotMatch(source, /\b(?:New-VM|Remove-VM|Start-VM|Stop-VM|virsh|qemu-system)\b/u);
  assert.match(source, /createUbuntuProductionImagePhysicalCanary/u);
  assert.match(source, /selectSerialProfileAction/u);
  assert.match(source, /physical = await canary\.status\(\)/u);
  assert.match(source, /if \(decision\.state === 'ready'\)/u);
  assert.match(source, /reconcileWindowsConstruction\('advance'\)/u);
  assert.match(source, /physical = await canary\.run\(\)/u);
});

test('public construction and runner tracking stay on the setup surface without exposing physical config paths', async () => {
  const source = await readFile(CLI, 'utf8');
  assert.match(source, /devbridge setup \[--profiles <linux\|windows\|both\|none\|defer>\] \[--construct\] \[--windows-distribution <local-reconstruction>\] \[--windows-activation <later>\] \[--track-ref <branch>\]/u);
  assert.match(source, /trackInstalledRunnerRef/u);
  assert.match(source, /construct: selected\.construct/u);
  assert.doesNotMatch(source, /ubuntu-production-image-canary-entry/u);
  assert.doesNotMatch(source, /physical-canary-config/u);
});

test('path visibility is a closed context-neutral LEGO', async () => {
  const source = await readFile(PATH_VISIBILITY, 'utf8');
  assert.doesNotMatch(source, /\bfrom\s+['"]\.{1,2}\//u);
  assert.doesNotMatch(source, /\b(?:DevBridge|setup|Windows|PowerShell|agent|controller|launcher)\b/iu);
  assert.match(source, /Object\.keys\(input\)/u);
  assert.match(source, /not-persisted/u);
  assert.match(source, /refresh-required/u);
  assert.match(source, /caller-omitted/u);
  assert.match(source, /available/u);
});

test('installed command resolution exposes a neutral local action', async () => {
  const source = await readFile(new URL('../src/setup/path-installation.js', import.meta.url), 'utf8');
  assert.match(source, /export async function resolveInstalledCommand/u);
  assert.doesNotMatch(source, /resolveInstalledDevBridgeCommand/u);
});
