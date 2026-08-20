#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, '..', '..');
const NODE_VERSION = '24.19.0';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-linux-x64.tar.xz`;
const NODE_DIGEST = '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function boundedPublicKey(value) {
  const key = String(value).trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]{40,256}(?: [^\r\n]{1,128})?$/u.test(key)) {
    throw new Error('guest access public key is invalid');
  }
  return key;
}

async function encoded(relative) {
  return (await readFile(path.join(REPOSITORY_ROOT, relative))).toString('base64');
}

const output = path.resolve(argument('--output'));
const publicKey = boundedPublicKey(await readFile(path.resolve(argument('--public-key')), 'utf8'));
await mkdir(output, { recursive: true, mode: 0o700 });

const bridgeAgent = await encoded('src/guest/bridge-agent.mjs');
const bootstrapAgent = await encoded('src/guest/environment-bootstrap-agent.mjs');
const networkAgent = await encoded('src/guest/network-seed-agent.mjs');

const networkService = `[Unit]
Description=Apply the current local development network seed
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/local/bin/node /usr/local/libexec/devbridge/network-seed-agent.mjs --watch
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

const cloudConfig = {
  autoinstall: {
    version: 1,
    locale: 'en_US.UTF-8',
    keyboard: { layout: 'us' },
    storage: { layout: { name: 'direct' } },
    ssh: { 'install-server': true, 'allow-pw': false },
    packages: [
      'build-essential',
      'ca-certificates',
      'cmake',
      'curl',
      'git',
      'linux-cloud-tools-virtual',
      'linux-tools-virtual',
      'linux-virtual',
      'openssh-server',
    ],
    updates: 'security',
    shutdown: 'poweroff',
    'late-commands': [
      [
        'curtin', 'in-target', '--', 'bash', '-c',
        `set -eu; curl -fsSLo /tmp/${NODE_ARCHIVE} https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}; echo '${NODE_DIGEST}  /tmp/${NODE_ARCHIVE}' | sha256sum -c -; tar -xJf /tmp/${NODE_ARCHIVE} -C /usr/local --strip-components=1; rm -f /tmp/${NODE_ARCHIVE}; node --version; npm --version`,
      ],
      ['curtin', 'in-target', '--', 'mkdir', '-p', '/var/lib/devbridge/bridge', '/var/lib/devbridge/bootstrap'],
    ],
    'user-data': {
      preserve_hostname: false,
      hostname: 'devbridge-base',
      disable_root: true,
      ssh_pwauth: false,
      users: [
        {
          name: 'devbridge',
          gecos: 'DevBridge guest operator',
          groups: ['adm', 'sudo'],
          shell: '/bin/bash',
          lock_passwd: true,
          sudo: ['ALL=(ALL) NOPASSWD:ALL'],
          ssh_authorized_keys: [publicKey],
        },
      ],
      write_files: [
        { path: '/usr/local/libexec/devbridge/bridge-agent.mjs', owner: 'root:root', permissions: '0755', encoding: 'b64', content: bridgeAgent },
        { path: '/usr/local/libexec/devbridge/environment-bootstrap-agent.mjs', owner: 'root:root', permissions: '0755', encoding: 'b64', content: bootstrapAgent },
        { path: '/usr/local/libexec/devbridge/network-seed-agent.mjs', owner: 'root:root', permissions: '0755', encoding: 'b64', content: networkAgent },
        { path: '/etc/systemd/system/devbridge-network-seed.service', owner: 'root:root', permissions: '0644', content: networkService },
      ],
      runcmd: [
        ['mkdir', '-p', '/var/lib/devbridge/bridge', '/var/lib/devbridge/bootstrap'],
        ['chown', '-R', 'devbridge:devbridge', '/var/lib/devbridge'],
        ['systemctl', 'daemon-reload'],
        ['systemctl', 'enable', '--now', 'devbridge-network-seed.service'],
        ['systemctl', 'enable', '--now', 'hv-fcopy-daemon.service'],
      ],
    },
  },
};

await writeFile(path.join(output, 'user-data'), `#cloud-config\n${JSON.stringify(cloudConfig)}\n`, { encoding: 'utf8', mode: 0o600 });
await writeFile(path.join(output, 'meta-data'), 'instance-id: devbridge-base-ubuntu-2404-20260210\nlocal-hostname: devbridge-base\n', { encoding: 'utf8', mode: 0o600 });

process.stdout.write(`${JSON.stringify({ output, nodeVersion: NODE_VERSION, helpers: 3 })}\n`);
