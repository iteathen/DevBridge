import { createHash } from 'node:crypto';

const PROTOCOL = 'devbridge/ubuntu-production-seed-v1';
const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/=]{40,256}(?: [^\r\n]{0,128})?$/u;
const PRIVATE_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PAYLOAD_PATH = /^\/usr\/local\/libexec\/devbridge\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{0,79}$/u;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,159}$/u;
const SNAPSHOT = /^\d{8}T\d{6}Z$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MUTABLE_VERSION = /^(?:latest|stable|current|head|main|master)$/iu;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,122}\.service$/u;

function yamlString(value) { return JSON.stringify(String(value)); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function ipv4(value, name) { if (typeof value !== 'string' || !IPV4.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function publicKey(value, name) { const text = String(value ?? '').trim(); if (!PUBLIC_KEY.test(text)) throw new TypeError(`${name} is invalid`); return text; }
function privateKey(value) { const text = String(value ?? ''); if (!text.startsWith(PRIVATE_HEADER) || text.includes('\0') || Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new TypeError('temporary host private key is invalid'); return text; }
function packageVersion(value, name) { if (typeof value !== 'string' || !PACKAGE_VERSION.test(value) || !/\d/u.test(value) || MUTABLE_VERSION.test(value)) throw new TypeError(`${name} is invalid`); return value; }

function normalizePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('payload set is invalid');
  for (const key of Object.keys(raw)) if (!['generation', 'files'].includes(key)) throw new TypeError(`payload set.${key} is not allowed`);
  if (typeof raw.generation !== 'string' || !GENERATION.test(raw.generation)) throw new TypeError('payload generation is invalid');
  if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > 32) throw new TypeError('payload file set is invalid');
  let total = 0;
  const seen = new Set();
  const files = raw.files.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`payload file ${index} is invalid`);
    for (const key of Object.keys(entry)) if (!['path', 'content', 'bytes', 'sha256'].includes(key)) throw new TypeError(`payload file ${index}.${key} is not allowed`);
    if (typeof entry.path !== 'string' || !PAYLOAD_PATH.test(entry.path) || seen.has(entry.path)) throw new TypeError(`payload file ${index}.path is invalid`);
    if (typeof entry.content !== 'string' || entry.content.includes('\0')) throw new TypeError(`payload file ${index}.content is invalid`);
    const bytes = Buffer.byteLength(entry.content, 'utf8');
    if (bytes < 1 || bytes > 512 * 1024) throw new TypeError(`payload file ${index}.content is outside bounds`);
    const sha256 = digest(entry.content);
    if (entry.bytes !== undefined && (!Number.isSafeInteger(entry.bytes) || entry.bytes !== bytes)) throw new TypeError(`payload file ${index}.bytes does not match content`);
    if (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256) || entry.sha256 !== sha256)) throw new TypeError(`payload file ${index}.sha256 does not match content`);
    total += bytes;
    if (total > 2 * 1024 * 1024) throw new TypeError('payload file set is too large');
    seen.add(entry.path);
    return Object.freeze({ path: entry.path, content: entry.content, bytes, sha256 });
  });
  return Object.freeze({ generation: raw.generation, files });
}

function normalizePackages(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('package set is invalid');
  for (const key of Object.keys(raw)) if (!['generation', 'snapshot', 'packages'].includes(key)) throw new TypeError(`package set.${key} is not allowed`);
  if (typeof raw.generation !== 'string' || !GENERATION.test(raw.generation)) throw new TypeError('package generation is invalid');
  if (typeof raw.snapshot !== 'string' || !SNAPSHOT.test(raw.snapshot)) throw new TypeError('package snapshot is invalid');
  if (!Array.isArray(raw.packages) || raw.packages.length === 0 || raw.packages.length > 64) throw new TypeError('package set is invalid');
  const seen = new Set();
  const packages = raw.packages.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`package ${index} is invalid`);
    for (const key of Object.keys(entry)) if (!['name', 'version'].includes(key)) throw new TypeError(`package ${index}.${key} is not allowed`);
    if (typeof entry.name !== 'string' || !PACKAGE_NAME.test(entry.name) || seen.has(entry.name)) throw new TypeError(`package ${index}.name is invalid`);
    const version = packageVersion(entry.version, `package ${index}.version`);
    seen.add(entry.name);
    return Object.freeze({ name: entry.name, version, specification: `${entry.name}=${version}` });
  });
  return Object.freeze({ generation: raw.generation, snapshot: raw.snapshot, packages });
}

function normalizeNetwork(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('production seed network is invalid');
  if (raw.method === 'automatic') {
    for (const key of Object.keys(raw)) if (key !== 'method') throw new TypeError(`production seed network.${key} is not allowed`);
    return Object.freeze({ method: 'automatic' });
  }
  if (raw.method !== 'static') throw new TypeError('production seed network.method is invalid');
  const allowed = new Set(['method', 'address', 'prefixLength', 'gateway', 'dns']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`production seed network.${key} is not allowed`);
  if (!Number.isInteger(raw.prefixLength) || raw.prefixLength < 8 || raw.prefixLength > 30) throw new TypeError('production seed network.prefixLength is invalid');
  if (!Array.isArray(raw.dns) || raw.dns.length === 0 || raw.dns.length > 4) throw new TypeError('production seed network DNS set is invalid');
  return Object.freeze({
    method: 'static',
    address: ipv4(raw.address, 'production seed network address'),
    prefixLength: raw.prefixLength,
    gateway: ipv4(raw.gateway, 'production seed network gateway'),
    dns: [...new Set(raw.dns.map((entry) => ipv4(entry, 'production seed network DNS entry')))],
  });
}

function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('production seed request is invalid');
  const allowed = new Set(['identity', 'network', 'authorizedKey', 'hostPrivateKey', 'hostPublicKey']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`production seed request.${key} is not allowed`);
  if (typeof raw.identity !== 'string' || !SUBJECT.test(raw.identity)) throw new TypeError('production seed identity is invalid');
  return Object.freeze({
    identity: raw.identity,
    network: normalizeNetwork(raw.network),
    authorizedKey: publicKey(raw.authorizedKey, 'temporary authorized key'),
    hostPrivateKey: privateKey(raw.hostPrivateKey),
    hostPublicKey: publicKey(raw.hostPublicKey, 'temporary host public key'),
  });
}

function writeFileYaml(lines, { path, content, permissions = '0755' }, indent = '        ') {
  lines.push(`${indent}- path: ${yamlString(path)}`);
  lines.push(`${indent}  permissions: ${yamlString(permissions)}`);
  lines.push(`${indent}  encoding: b64`);
  lines.push(`${indent}  content: ${yamlString(Buffer.from(content, 'utf8').toString('base64'))}`);
}

function yamlList(values) { return `[${values.map(yamlString).join(', ')}]`; }

function normalizeServices(raw = []) {
  if (!Array.isArray(raw) || raw.length > 16) throw new TypeError('production seed service set is invalid');
  const seen = new Set();
  return Object.freeze(raw.map((entry, index) => {
    if (typeof entry !== 'string' || !SERVICE.test(entry) || seen.has(entry)) throw new TypeError(`production seed service ${index} is invalid`);
    seen.add(entry);
    return entry;
  }));
}

const NETWORK_UNIT = `[Unit]\nDescription=Apply locally supplied network state\nAfter=local-fs.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/node /usr/local/libexec/devbridge/network-seed-agent.mjs --watch\nRestart=always\nRestartSec=1\n\n[Install]\nWantedBy=multi-user.target\n`;
const ACCESS_UNIT = `[Unit]\nDescription=Apply locally supplied access state\nAfter=local-fs.target ssh.service\nWants=ssh.service\n\n[Service]\nType=simple\nExecStart=/usr/bin/node /usr/local/libexec/devbridge/linux-access-seed-agent.mjs --watch\nRestart=always\nRestartSec=1\n\n[Install]\nWantedBy=multi-user.target\n`;
const SANITIZER_PATH = '/usr/local/libexec/devbridge/image-sanitize.sh';
const SANITIZER = `#!/bin/sh\nset -eu\nrm -f /home/devbridge/.ssh/authorized_keys\nrm -f /etc/ssh/ssh_host_*\nrm -f /var/lib/devbridge/access/seed.json /var/lib/devbridge/access/state.json\nrm -f /var/lib/devbridge/bootstrap/network-seed.json /var/lib/devbridge/bootstrap/network-state.json\nrm -rf /home/devbridge/.local/state/devbridge\nrm -f /etc/netplan/00-installer-config.yaml /etc/netplan/50-cloud-init.yaml\nrm -rf /var/lib/cloud/instances/* /var/lib/cloud/seed/*\ncloud-init clean --logs --seed >/dev/null 2>&1 || true\nprintf 'localhost\\n' >/etc/hostname\nsed -i 's/devbridge-image-build/localhost/g' /etc/hosts || true\ntruncate -s 0 /etc/machine-id\nrm -f /var/lib/dbus/machine-id /var/lib/systemd/random-seed\nrm -f /home/devbridge/.bash_history /root/.bash_history\nrm -rf /var/lib/apt/lists/* /var/log/journal/*\nfind /tmp /var/tmp -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +\nrm -f /etc/sudoers.d/devbridge-image-build\nrm -f ${SANITIZER_PATH}\nsync\nprintf 'devbridge-image-sanitize-v1\\n'\nsystemctl poweroff --no-block\n`;
const TEMPORARY_SUDO = `devbridge ALL=(root) NOPASSWD: ${SANITIZER_PATH}\n`;

export class UbuntuProductionSeedFactory {
  #payloadSet;
  #packageSet;
  #services;

  constructor({ payloadSet, packageSet, services = [] } = {}) {
    if (typeof payloadSet !== 'function') throw new TypeError('payloadSet must be a function');
    if (typeof packageSet !== 'function') throw new TypeError('packageSet must be a function');
    this.#payloadSet = payloadSet;
    this.#packageSet = packageSet;
    this.#services = normalizeServices(services);
  }

  async create(rawRequest) {
    const request = normalizeRequest(rawRequest);
    const payload = normalizePayload(await this.#payloadSet());
    const packages = normalizePackages(await this.#packageSet());
    const packageSpecifications = packages.packages.map((entry) => entry.specification);
    const lines = ['#cloud-config', 'autoinstall:', '  version: 1', '  locale: en_US.UTF-8', '  keyboard:', '    layout: us', '  source:', '    id: ubuntu-server-minimal', '  apt:', '    conf: |', '      Unattended-Upgrade::Package-Blacklist {', '        ".*";', '      };', '  storage:', '    layout:', '      name: direct', '  network:', '    version: 2', '    ethernets:', '      build:', '        match:', '          name: "e*"'];
    if (request.network.method === 'automatic') {
      lines.push('        dhcp4: true', '        dhcp6: false');
    } else {
      lines.push('        dhcp4: false', '        addresses:', `          - ${yamlString(`${request.network.address}/${request.network.prefixLength}`)}`, '        routes:', '          - to: default', `            via: ${yamlString(request.network.gateway)}`, '        nameservers:', '          addresses:');
      for (const entry of request.network.dns) lines.push(`            - ${yamlString(entry)}`);
    }
    lines.push('  ssh:', '    install-server: true', '    allow-pw: false', '  late-commands:', `    - ${yamlList(['curtin', 'in-target', '--target=/target', '--', 'apt-get', '--error-on=any', '--snapshot', packages.snapshot, 'update'])}`, `    - ${yamlList(['curtin', 'in-target', '--target=/target', '--', 'apt-get', '--snapshot', packages.snapshot, 'upgrade', '-y', '--with-new-pkgs', '--no-remove'])}`, `    - ${yamlList(['curtin', 'in-target', '--target=/target', '--', 'apt-get', '--snapshot', packages.snapshot, 'install', '-y', '--no-install-recommends', ...packageSpecifications])}`, '  shutdown: poweroff', '  user-data:', '    users:', '      - name: devbridge', '        gecos: DevBridge Image Builder', '        groups: [adm, sudo]', '        shell: /bin/bash', '        lock_passwd: true', '        ssh_authorized_keys:', `          - ${yamlString(request.authorizedKey)}`, '    ssh_deletekeys: true', '    ssh_keys:', `      ed25519_private: ${yamlString(request.hostPrivateKey)}`, `      ed25519_public: ${yamlString(request.hostPublicKey)}`, '    write_files:');
    for (const file of payload.files) writeFileYaml(lines, file);
    writeFileYaml(lines, { path: '/etc/systemd/system/devbridge-network-seed.service', content: NETWORK_UNIT, permissions: '0644' });
    writeFileYaml(lines, { path: '/etc/systemd/system/devbridge-access-seed.service', content: ACCESS_UNIT, permissions: '0644' });
    writeFileYaml(lines, { path: SANITIZER_PATH, content: SANITIZER, permissions: '0755' });
    writeFileYaml(lines, { path: '/etc/sudoers.d/devbridge-image-build', content: TEMPORARY_SUDO, permissions: '0440' });
    lines.push('    runcmd:', '      - [systemctl, daemon-reload]');
    for (const service of this.#services) lines.push(`      - ${yamlList(['systemctl', 'enable', '--now', service])}`);
    lines.push('      - [systemctl, enable, --now, devbridge-network-seed.service]', '      - [systemctl, enable, --now, devbridge-access-seed.service]', '      - [systemctl, restart, ssh]');

    const userData = `${lines.join('\n')}\n`;
    const fileEvidence = payload.files.map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }));
    return Object.freeze({
      userData,
      metaData: `instance-id: devbridge-image-${request.identity.slice('subject-'.length)}\nlocal-hostname: devbridge-image-build\n`,
      evidence: Object.freeze({
        protocol: PROTOCOL,
        payloadGeneration: payload.generation,
        files: fileEvidence,
        packageGeneration: packages.generation,
        packageSnapshot: packages.snapshot,
        packages: packages.packages.map(({ name, version }) => ({ name, version })),
        services: [...this.#services],
        networkMethod: request.network.method,
        userDataSha256: digest(userData),
      }),
    });
  }
}

export function createUbuntuProductionSeedFactory(options) {
  return new UbuntuProductionSeedFactory(options);
}
