import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('neutral setup-conflict contract contains no provider or topology identity', async () => {
  const source = await readFile(new URL('../src/setup/resource-conflict.js', import.meta.url), 'utf8');
  for (const forbidden of [
    /hyper-?v/iu,
    /windows/iu,
    /netnat/iu,
    /switch/iu,
    /virtual machine/iu,
    /repository/iu,
    /github/iu,
    /credential/iu,
    /provider object/iu,
  ]) assert.doesNotMatch(source, forbidden);
});

test('setup-conflict persistence depends only on its local neutral value contract', async () => {
  const source = await readFile(new URL('../src/state/setup-resource-conflict-consent-store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /hyper-?v|netnat|vmswitch|repository|github/iu);
  assert.match(source, /resource-conflict\.js/u);
});
