import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PolicyError } from '../errors.js';

export const AGENT_IDENTITY_PROTOCOL = 'devbridge/agent-identity-v1';
export const AGENT_IDENTITY_FILE = 'agent-identity-v1.json';

const HANDLE_RE = /^[A-Za-z0-9_.-]{1,40}$/u;
const MAX_KEY_BYTES = 1024;
const IDENTITY_KEYS = new Set(['protocol', 'publicKeySpki', 'privateKeyPkcs8']);

function decodeBoundedBase64(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new PolicyError(`${name} must be bounded base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_KEY_BYTES || bytes.toString('base64') !== value) {
    throw new PolicyError(`${name} is not canonical bounded base64`);
  }
  return bytes;
}

export function validateAgentHandle(value, name = 'coordination.handle') {
  if (typeof value !== 'string' || !HANDLE_RE.test(value)) throw new PolicyError(`${name} must be a safe 1-40 character handle`);
  return value;
}

export function agentFingerprint(publicKeySpki) {
  const bytes = Buffer.isBuffer(publicKeySpki)
    ? publicKeySpki
    : decodeBoundedBase64(publicKeySpki, 'agent public key');
  return createHash('sha256').update(bytes).digest('hex');
}

function exportPublicDer(key) {
  return Buffer.from(key.export({ format: 'der', type: 'spki' }));
}

function exportPrivateDer(key) {
  return Buffer.from(key.export({ format: 'der', type: 'pkcs8' }));
}

function parseIdentityRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError('agent identity record must be an object');
  for (const key of Object.keys(raw)) if (!IDENTITY_KEYS.has(key)) throw new PolicyError(`agent identity record field ${key} is not allowed`);
  if (raw.protocol !== AGENT_IDENTITY_PROTOCOL) throw new PolicyError('agent identity protocol is unsupported');

  const publicDer = decodeBoundedBase64(raw.publicKeySpki, 'agent identity publicKeySpki');
  const privateDer = decodeBoundedBase64(raw.privateKeyPkcs8, 'agent identity privateKeyPkcs8');
  let publicKey;
  let privateKey;
  try {
    publicKey = createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
    privateKey = createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
  } catch (error) {
    throw new PolicyError('agent identity contains an invalid key', { cause: error });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new PolicyError('agent identity keys must use Ed25519');
  }
  const derivedPublic = exportPublicDer(createPublicKey(privateKey));
  if (!derivedPublic.equals(exportPublicDer(publicKey))) throw new PolicyError('agent identity public/private keys do not match');
  return { publicKey, privateKey, publicDer, privateDer };
}

function createIdentityRecord() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = exportPublicDer(publicKey);
  const privateDer = exportPrivateDer(privateKey);
  return {
    record: {
      protocol: AGENT_IDENTITY_PROTOCOL,
      publicKeySpki: publicDer.toString('base64'),
      privateKeyPkcs8: privateDer.toString('base64'),
    },
    parsed: { publicKey, privateKey, publicDer, privateDer },
  };
}

async function readExistingIdentity(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new PolicyError('agent identity path must be a regular non-symlink file');
  if (info.size <= 0 || info.size > 16 * 1024) throw new PolicyError('agent identity file size is invalid');
  let raw;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new PolicyError('agent identity file is invalid JSON', { cause: error });
  }
  return parseIdentityRecord(raw);
}

function publicIdentity(handle, parsed, filePath) {
  const fingerprint = agentFingerprint(parsed.publicDer);
  const publicKeySpki = parsed.publicDer.toString('base64');
  return {
    protocol: AGENT_IDENTITY_PROTOCOL,
    handle,
    fingerprint,
    address: `${handle}#${fingerprint}`,
    publicKeySpki,
    filePath,
    sign(bytes) {
      const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return signBytes(null, payload, parsed.privateKey).toString('base64');
    },
    verify(bytes, signature) {
      if (typeof signature !== 'string') return false;
      let decoded;
      try { decoded = decodeBoundedBase64(signature, 'agent signature'); }
      catch { return false; }
      const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return verifyBytes(null, payload, parsed.publicKey, decoded);
    },
    publicProjection() {
      return { protocol: AGENT_IDENTITY_PROTOCOL, handle, fingerprint, address: `${handle}#${fingerprint}`, publicKeySpki };
    },
  };
}

export function importAgentPublicIdentity({ handle, publicKeySpki }) {
  const normalizedHandle = validateAgentHandle(handle, 'peer handle');
  const publicDer = decodeBoundedBase64(publicKeySpki, 'peer publicKeySpki');
  let publicKey;
  try { publicKey = createPublicKey({ key: publicDer, format: 'der', type: 'spki' }); }
  catch (error) { throw new PolicyError('peer public key is invalid', { cause: error }); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new PolicyError('peer public key must use Ed25519');
  const canonicalDer = exportPublicDer(publicKey);
  const fingerprint = agentFingerprint(canonicalDer);
  return {
    handle: normalizedHandle,
    fingerprint,
    address: `${normalizedHandle}#${fingerprint}`,
    publicKeySpki: canonicalDer.toString('base64'),
    verify(bytes, signature) {
      if (typeof signature !== 'string') return false;
      let decoded;
      try { decoded = decodeBoundedBase64(signature, 'agent signature'); }
      catch { return false; }
      const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return verifyBytes(null, payload, publicKey, decoded);
    },
  };
}

export async function loadOrCreateAgentIdentity({ directory, handle }) {
  const normalizedHandle = validateAgentHandle(handle);
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const filePath = path.join(root, AGENT_IDENTITY_FILE);
  let parsed = await readExistingIdentity(filePath);
  if (!parsed) {
    const created = createIdentityRecord();
    const content = `${JSON.stringify(created.record, null, 2)}\n`;
    try {
      await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      parsed = created.parsed;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      parsed = await readExistingIdentity(filePath);
      if (!parsed) throw new PolicyError('agent identity creation raced without a recoverable identity file');
    }
  }
  return publicIdentity(normalizedHandle, parsed, filePath);
}
