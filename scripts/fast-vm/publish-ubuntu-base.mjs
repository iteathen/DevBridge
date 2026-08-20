#!/usr/bin/env node

import path from 'node:path';
import { createEnvironmentFoundation } from '../../src/app/environment-foundation.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function digest(value, name) {
  const normalized = String(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${name} must be a SHA-256 digest`);
  return normalized;
}

const stateDirectory = path.resolve(argument('--state-directory'));
const source = path.resolve(argument('--source'));
const expectedDigest = digest(argument('--source-sha256'), 'source digest');
const foundation = await createEnvironmentFoundation({ stateDirectory });
const before = await foundation.inspect();
if (before.capabilities.management.ready !== true) throw new Error(before.capabilities.management.reason ?? 'Hyper-V management is unavailable');

const image = await foundation.publishImage({
  profile: 'linux-development',
  generation: 'ubuntu-24.04.4-node-24.19.0-fast-v1',
  source,
  expectedDigest,
  provenance: {
    origin: 'locally-built-from-verified-ubuntu-installer',
    canonical_installer_sha256: digest(argument('--canonical-installer-sha256'), 'canonical installer digest'),
    unattended_installer_sha256: digest(argument('--unattended-installer-sha256'), 'unattended installer digest'),
    seed_sha256: digest(argument('--seed-sha256'), 'seed digest'),
    guest_runtime: 'node-v24.19.0-linux-x64',
    guest_runtime_sha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647',
    host_key_policy: 'retained-single-environment-fast-only',
  },
});
const verified = await foundation.verifyImage(image.identity);
if (verified.usable !== true || verified.verified !== true) throw new Error(verified.reason ?? 'published image verification failed');
process.stdout.write(`${JSON.stringify({ image, verified })}\n`);
