import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SETUP_APP = new URL('../src/app/setup.js', import.meta.url);
const CLI = new URL('../src/cli.js', import.meta.url);

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
  assert.match(source, /devbridge setup \[--profiles <linux\|windows\|both\|none\|defer>\] \[--construct\] \[--windows-activation <later>\] \[--track-ref <branch>\]/u);
  assert.match(source, /trackInstalledRunnerRef/u);
  assert.match(source, /construct: selected\.construct/u);
  assert.doesNotMatch(source, /ubuntu-production-image-canary-entry/u);
  assert.doesNotMatch(source, /physical-canary-config/u);
});
