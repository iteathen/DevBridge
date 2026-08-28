import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = new URL('../src/runtime/bounded-text-read.js', import.meta.url);

test('bounded text read remains isolated from topology and caller policy', async () => {
  const text = await readFile(source, 'utf8');
  for (const forbidden of [
    'daemon', 'pause', 'resume', 'stop', 'provider', 'repository', 'guest', 'controller',
    'Hyper-V', 'libvirt', 'QEMU', 'Windows', 'setup', 'config', 'process.env',
  ]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} leaked into the text-read module`);
  }
  assert.match(text, /Object\.freeze\(\[5, 10, 20, 40, 80, 160, 320, 640\]\)/u);
  assert.equal(/retry|delay|code/iu.test(text.match(/\{ read = readFile, wait = defaultWait \}/u)?.[0] ?? ''), false);
});
