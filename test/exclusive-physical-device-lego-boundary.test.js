import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ExclusivePhysicalDevices } from '../src/runtime/exclusive-physical-devices.js';

const authorityFile = new URL('../src/runtime/exclusive-physical-devices.js', import.meta.url);

test('exclusive physical-device authority exposes only neutral lifecycle studs', () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(ExclusivePhysicalDevices.prototype),
    ['constructor', 'observe', 'claim', 'release', 'reconcile'],
  );
});

test('neutral physical-device authority contains no provider, bus, vendor, or repository topology identities', async () => {
  const source = await readFile(authorityFile, 'utf8');
  const forbidden = [
    /\bpci(?:e)?\b/iu,
    /\bpnp\b/iu,
    /\bwhp\b/iu,
    /\bvpci\b/iu,
    /hyper-?v/iu,
    /libvirt/iu,
    /\bvfio\b/iu,
    /\biommu\b/iu,
    /\bqemu\b/iu,
    /powershell/iu,
    /\bnvidia\b/iu,
    /\bcuda\b/iu,
    /repositoryexecution/iu,
    /workerexchange/iu,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `neutral device authority leaked ${pattern}`);
});
