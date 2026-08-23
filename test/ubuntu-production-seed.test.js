import test from 'node:test';
import assert from 'node:assert/strict';
import { UbuntuProductionSeedFactory } from '../src/runtime/image-builders/ubuntu-production-seed.js';

const publicKey = `ssh-ed25519 ${'A'.repeat(44)} build-key`;
const hostPrivateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\ntransient-private-material\n-----END OPENSSH PRIVATE KEY-----\n';
const hostPublicKey = `ssh-ed25519 ${'B'.repeat(44)} build-host`;

function request(overrides = {}) {
  return {
    identity: 'subject-0123456789abcdef0123456789abcdef',
    address: '192.168.77.23',
    prefixLength: 24,
    gateway: '192.168.77.1',
    dns: ['1.1.1.1', '8.8.8.8'],
    authorizedKey: publicKey,
    hostPrivateKey,
    hostPublicKey,
    ...overrides,
  };
}

function factory(overrides = {}) {
  return new UbuntuProductionSeedFactory({
    payloadSet: async () => ({
      generation: 'guest-payload-v7',
      files: [
        { path: '/usr/local/libexec/devbridge/bridge-agent.mjs', content: 'console.log("bridge");\n' },
        { path: '/usr/local/libexec/devbridge/network-seed-agent.mjs', content: 'console.log("network");\n' },
        { path: '/usr/local/libexec/devbridge/linux-access-seed-agent.mjs', content: 'console.log("access");\n' },
      ],
    }),
    packageSet: async () => ({
      generation: 'ubuntu-tools-v4',
      packages: [
        { name: 'build-essential', version: '12.12ubuntu1' },
        { name: 'ca-certificates', version: '20240203' },
        { name: 'cmake', version: '3.31.6-1' },
        { name: 'curl', version: '8.12.1-1ubuntu1' },
        { name: 'git', version: '1:2.48.1-0ubuntu1' },
        { name: 'linux-cloud-tools-virtual', version: '6.14.0.29.29' },
        { name: 'nodejs', version: '22.16.0+dfsg-1' },
        { name: 'npm', version: '10.9.2+ds-1' },
        { name: 'openssh-server', version: '1:9.9p1-3ubuntu3' },
      ],
    }),
    ...overrides,
  });
}

function embeddedContents(userData) {
  return [...userData.matchAll(/^\s+content: "([A-Za-z0-9+/=]+)"$/gmu)].map((match) => Buffer.from(match[1], 'base64').toString('utf8'));
}

test('Ubuntu production seed binds exact package and payload generations without latest-update authority', async () => {
  const result = await factory().create(request());
  assert.match(result.userData, /^#cloud-config\nautoinstall:/u);
  assert.match(result.userData, /"nodejs=22\.16\.0\+dfsg-1"/u);
  assert.match(result.userData, /"linux-cloud-tools-virtual=6\.14\.0\.29\.29"/u);
  assert.match(result.userData, /apt-get", "install", "-y", "--no-install-recommends"/u);
  assert.doesNotMatch(result.userData, /updates:\s+security/u);
  assert.doesNotMatch(result.userData, /install-server:\s+true/u);
  assert.equal(result.evidence.payloadGeneration, 'guest-payload-v7');
  assert.equal(result.evidence.packageGeneration, 'ubuntu-tools-v4');
  assert.equal(result.evidence.packages.find((entry) => entry.name === 'git').version, '1:2.48.1-0ubuntu1');
  assert.equal(result.evidence.files.length, 3);
  assert.match(result.evidence.userDataSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(result.evidence).includes('transient-private-material'), false);
  assert.equal(JSON.stringify(result.evidence).includes(publicKey), false);
  assert.match(result.metaData, /^instance-id: devbridge-image-/u);
});

test('Ubuntu production seed limits temporary privilege to one self-removing sanitizer that powers off only after cleanup', async () => {
  const result = await factory().create(request());
  const embedded = embeddedContents(result.userData);
  const sudoers = embedded.find((entry) => entry.startsWith('devbridge ALL='));
  const sanitizer = embedded.find((entry) => entry.startsWith('#!/bin/sh\nset -eu\n'));
  assert.equal(sudoers, 'devbridge ALL=(root) NOPASSWD: /usr/local/libexec/devbridge/image-sanitize.sh\n');
  assert.ok(sanitizer);
  assert.match(sanitizer, /rm -f \/home\/devbridge\/\.ssh\/authorized_keys/u);
  assert.match(sanitizer, /rm -f \/etc\/ssh\/ssh_host_\*/u);
  assert.match(sanitizer, /rm -rf \/var\/lib\/devbridge\/bridge/u);
  assert.match(sanitizer, /truncate -s 0 \/etc\/machine-id/u);
  assert.match(sanitizer, /rm -f \/etc\/sudoers\.d\/devbridge-image-build/u);
  assert.match(sanitizer, /rm -f \/usr\/local\/libexec\/devbridge\/image-sanitize\.sh/u);
  const sentinel = sanitizer.indexOf("printf 'devbridge-image-sanitize-v1\\n'");
  const poweroff = sanitizer.indexOf('systemctl poweroff --no-block');
  assert.ok(sentinel > 0);
  assert.ok(poweroff > sentinel);
});

test('Ubuntu production seed embeds transient access only in seed material and enables future local seed agents', async () => {
  const result = await factory().create(request());
  assert.equal(result.userData.includes(Buffer.from(hostPrivateKey, 'utf8').toString('base64')), true);
  assert.equal(result.userData.includes(Buffer.from('console.log("bridge");\n', 'utf8').toString('base64')), true);
  assert.match(result.userData, /devbridge-network-seed\.service/u);
  assert.match(result.userData, /devbridge-access-seed\.service/u);
  assert.match(result.userData, /shutdown:\s+poweroff/u);
});

test('Ubuntu production seed rejects mutable or ambiguous package authority', async () => {
  await assert.rejects(() => new UbuntuProductionSeedFactory({
    payloadSet: async () => ({ generation: 'payload-v1', files: [{ path: '/usr/local/libexec/devbridge/a.mjs', content: 'x' }] }),
    packageSet: async () => ({ generation: 'packages-v1', packages: [{ name: 'nodejs', version: 'latest' }] }),
  }).create(request()), /package 0.version is invalid/u);

  await assert.rejects(() => new UbuntuProductionSeedFactory({
    payloadSet: async () => ({ generation: 'payload-v1', files: [{ path: '/usr/local/libexec/devbridge/a.mjs', content: 'x' }] }),
    packageSet: async () => ({ generation: 'packages-v1', packages: [{ name: 'nodejs', version: '22.16.0' }, { name: 'nodejs', version: '22.16.1' }] }),
  }).create(request()), /package 1.name is invalid/u);
});

test('Ubuntu production seed keeps its input contract topology-neutral', async () => {
  await assert.rejects(() => factory().create(request({ repository: 'iteathen/DevBridge' })), /repository is not allowed/u);
  await assert.rejects(() => factory().create(request({ hypervisor: 'hyperv' })), /hypervisor is not allowed/u);
});
