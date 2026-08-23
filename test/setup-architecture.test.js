import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SETUP_APP = new URL('../src/app/setup.js', import.meta.url);

test('generic setup composes through the canary app instead of provider internals', async () => {
  const source = await readFile(SETUP_APP, 'utf8');
  assert.doesNotMatch(source, /runtime\/providers\//u);
  assert.doesNotMatch(source, /\b(?:New-VM|Remove-VM|Start-VM|Stop-VM|virsh|qemu-system)\b/u);
  assert.match(source, /createUbuntuProductionImagePhysicalCanary/u);
  assert.match(source, /physical = await canary\.status\(\)/u);
  assert.doesNotMatch(source, /canary\.run\s*\(/u);
});
