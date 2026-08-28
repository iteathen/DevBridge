import { createHash } from 'node:crypto';

export const WINDOWS_TOOLCHAIN_AUTHORITY_PROTOCOL = 'devbridge/windows-toolchain-authority-v1';

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$/u;
const EXPECTED_IDENTITIES = Object.freeze(['build-tools', 'node', 'source-control']);

const DEFAULT_AUTHORITY = Object.freeze({
  protocol: WINDOWS_TOOLCHAIN_AUTHORITY_PROTOCOL,
  generation: 'windows-build-basics-20260828-v2',
  artifacts: Object.freeze([
    Object.freeze({
      identity: 'build-tools',
      version: '17.14.39',
      installedVersion: '17.14.37614.0',
      uri: 'https://download.visualstudio.microsoft.com/download/pr/fa619120-9c0e-47e6-bfe0-3ee96fb671b2/236367b68ba9a51708263ab10a1c85546cc4a8eca78b365168811d19c4fb2f29/vs_BuildTools.exe',
      bytes: 4473936,
      sha256: '236367b68ba9a51708263ab10a1c85546cc4a8eca78b365168811d19c4fb2f29',
      approval: Object.freeze({
        reference: 'https://learn.microsoft.com/en-us/visualstudio/releases/2022/release-history',
        expectedSha256: '236367b68ba9a51708263ab10a1c85546cc4a8eca78b365168811d19c4fb2f29',
      }),
    }),
    Object.freeze({
      identity: 'node',
      version: '22.23.2',
      uri: 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-x64.msi',
      bytes: 31727616,
      sha256: 'ce9572ae220c345fbae2340bbb4d084e8ca5e0fe093ee7067d43094ae23be989',
      approval: Object.freeze({ reference: 'https://nodejs.org/dist/v22.23.2/SHASUMS256.txt', expectedSha256: 'ce9572ae220c345fbae2340bbb4d084e8ca5e0fe093ee7067d43094ae23be989' }),
    }),
    Object.freeze({
      identity: 'source-control',
      version: '2.55.0.windows.5',
      uri: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe',
      bytes: 65343712,
      sha256: 'd065a4e23c3d9a6b5073d609b5be0830227ec3ca053c083ba385061ddfaf94c6',
      approval: Object.freeze({ reference: 'https://api.github.com/repos/git-for-windows/git/releases/tags/v2.55.0.windows.5', expectedSha256: 'd065a4e23c3d9a6b5073d609b5be0830227ec3ca053c083ba385061ddfaf94c6' }),
    }),
  ]),
});

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function https(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${name} is invalid`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) throw new TypeError(`${name} is invalid`);
  return parsed;
}

function approvedUri(identity, value) {
  const parsed = https(value, `toolchain artifact ${identity} uri`);
  const host = parsed.hostname.toLowerCase();
  if (identity === 'build-tools' && host === 'download.visualstudio.microsoft.com' && /\/vs_BuildTools\.exe$/u.test(parsed.pathname)) return parsed.toString();
  if (identity === 'node' && host === 'nodejs.org' && /^\/dist\/v\d+\.\d+\.\d+\/node-v\d+\.\d+\.\d+-x64\.msi$/u.test(parsed.pathname)) return parsed.toString();
  if (identity === 'source-control' && host === 'github.com' && /^\/git-for-windows\/git\/releases\/download\/[^/]+\/Git-[^/]+-64-bit\.exe$/u.test(parsed.pathname)) return parsed.toString();
  throw new TypeError(`toolchain artifact ${identity} uri is not approved`);
}

function normalizeApproval(raw, artifact, identity) {
  const value = onlyKeys(raw, new Set(['reference', 'expectedSha256']), `toolchain artifact ${identity} approval`);
  const reference = https(value.reference, `toolchain artifact ${identity} approval reference`).toString();
  if (typeof value.expectedSha256 !== 'string' || !SHA256.test(value.expectedSha256) || value.expectedSha256 !== artifact.sha256) throw new TypeError(`toolchain artifact ${identity} approved digest does not match`);
  return Object.freeze({ reference, expectedSha256: value.expectedSha256 });
}

function normalizeArtifact(raw, expectedIdentity) {
  const value = onlyKeys(raw, new Set(['identity', 'version', 'installedVersion', 'uri', 'bytes', 'sha256', 'approval']), `toolchain artifact ${expectedIdentity}`);
  if (value.identity !== expectedIdentity) throw new TypeError(`toolchain artifact ${expectedIdentity} identity is invalid`);
  if (typeof value.version !== 'string' || !SAFE_ID.test(value.version)) throw new TypeError(`toolchain artifact ${expectedIdentity} version is invalid`);
  if (expectedIdentity === 'build-tools') {
    if (typeof value.installedVersion !== 'string' || !/^17\.14\.\d{5}\.\d+$/u.test(value.installedVersion)) throw new TypeError('toolchain artifact build-tools installedVersion is invalid');
  } else if (value.installedVersion !== undefined) {
    throw new TypeError(`toolchain artifact ${expectedIdentity} installedVersion is not allowed`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 4 * 1024 * 1024 * 1024) throw new TypeError(`toolchain artifact ${expectedIdentity} bytes is invalid`);
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) throw new TypeError(`toolchain artifact ${expectedIdentity} sha256 is invalid`);
  const artifact = {
    identity: expectedIdentity,
    version: value.version,
    ...(expectedIdentity === 'build-tools' ? { installedVersion: value.installedVersion } : {}),
    uri: approvedUri(expectedIdentity, value.uri),
    bytes: value.bytes,
    sha256: value.sha256,
  };
  return Object.freeze({ ...artifact, approval: normalizeApproval(value.approval, artifact, expectedIdentity) });
}

export function normalizeWindowsToolchainAuthority(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'generation', 'artifacts']), 'toolchain authority');
  if (value.protocol !== WINDOWS_TOOLCHAIN_AUTHORITY_PROTOCOL) throw new TypeError('toolchain authority protocol is unsupported');
  if (typeof value.generation !== 'string' || !SAFE_ID.test(value.generation)) throw new TypeError('toolchain authority generation is invalid');
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== EXPECTED_IDENTITIES.length) throw new TypeError('toolchain authority artifacts are invalid');
  const artifacts = EXPECTED_IDENTITIES.map((identity, index) => normalizeArtifact(value.artifacts[index], identity));
  return Object.freeze({ protocol: WINDOWS_TOOLCHAIN_AUTHORITY_PROTOCOL, generation: value.generation, artifacts: Object.freeze(artifacts) });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function windowsToolchainAuthoritySubject(raw) {
  const authority = normalizeWindowsToolchainAuthority(raw);
  return `subject-${createHash('sha256').update(JSON.stringify(stable(authority)), 'utf8').digest('hex').slice(0, 32)}`;
}

export function createDefaultWindowsToolchainAuthority() {
  return normalizeWindowsToolchainAuthority(structuredClone(DEFAULT_AUTHORITY));
}
