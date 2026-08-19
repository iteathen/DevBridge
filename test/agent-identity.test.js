import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_IDENTITY_FILE,
  AGENT_IDENTITY_PROTOCOL,
  importAgentPublicIdentity,
  loadOrCreateAgentIdentity,
} from '../src/security/agent-identity.js';

function publicSpkiBase64(publicKey) {
  return Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
}

test('agent identity is stable across reload and public projection never exposes private material', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-agent-identity-'));
  try {
    const first = await loadOrCreateAgentIdentity({ directory: root, handle: 'workstation-a' });
    const second = await loadOrCreateAgentIdentity({ directory: root, handle: 'workstation-a' });
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(second.publicKeySpki, first.publicKeySpki);
    assert.equal(second.address, `workstation-a#${first.fingerprint}`);
    assert.match(first.fingerprint, /^[0-9a-f]{64}$/u);

    const stored = JSON.parse(await readFile(path.join(root, AGENT_IDENTITY_FILE), 'utf8'));
    assert.equal(stored.protocol, AGENT_IDENTITY_PROTOCOL);
    assert.equal(typeof stored.privateKeyPkcs8, 'string');
    const projected = first.publicProjection();
    assert.equal(Object.hasOwn(projected, 'privateKeyPkcs8'), false);
    assert.equal(JSON.stringify(projected).includes(stored.privateKeyPkcs8), false);
    assert.equal(Object.hasOwn(projected, 'filePath'), false);

    const payload = Buffer.from('bounded lease subject', 'utf8');
    const signature = first.sign(payload);
    assert.equal(first.verify(payload, signature), true);
    assert.equal(first.verify(Buffer.from('changed', 'utf8'), signature), false);

    const peer = importAgentPublicIdentity({ handle: 'peer', publicKeySpki: first.publicKeySpki });
    assert.equal(peer.fingerprint, first.fingerprint);
    assert.equal(peer.verify(payload, signature), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent identity rejects malformed or mismatched key material', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-agent-identity-invalid-'));
  try {
    await loadOrCreateAgentIdentity({ directory: root, handle: 'worker' });
    const identityPath = path.join(root, AGENT_IDENTITY_FILE);
    const stored = JSON.parse(await readFile(identityPath, 'utf8'));
    const other = generateKeyPairSync('ed25519');
    stored.publicKeySpki = publicSpkiBase64(other.publicKey);
    await writeFile(identityPath, `${JSON.stringify(stored)}\n`, { encoding: 'utf8' });
    await assert.rejects(
      loadOrCreateAgentIdentity({ directory: root, handle: 'worker' }),
      /public\/private keys do not match/u,
    );

    await writeFile(identityPath, '{not-json', { encoding: 'utf8' });
    await assert.rejects(
      loadOrCreateAgentIdentity({ directory: root, handle: 'worker' }),
      /invalid JSON/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent identity refuses a symlinked identity file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-agent-identity-link-'));
  const other = await mkdtemp(path.join(os.tmpdir(), 'pp-agent-identity-target-'));
  try {
    await loadOrCreateAgentIdentity({ directory: other, handle: 'worker' });
    const target = path.join(other, AGENT_IDENTITY_FILE);
    const linked = path.join(root, AGENT_IDENTITY_FILE);
    try {
      await symlink(target, linked, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('Windows runner does not permit file symlink creation');
        return;
      }
      throw error;
    }
    await assert.rejects(
      loadOrCreateAgentIdentity({ directory: root, handle: 'worker' }),
      /regular non-symlink file/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('peer public identity rejects unsafe handles and non-Ed25519 keys', () => {
  const ed = generateKeyPairSync('ed25519');
  assert.throws(
    () => importAgentPublicIdentity({ handle: '../peer', publicKeySpki: publicSpkiBase64(ed.publicKey) }),
    /safe 1-40 character handle/u,
  );
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(
    () => importAgentPublicIdentity({ handle: 'peer', publicKeySpki: publicSpkiBase64(rsa.publicKey) }),
    /must use Ed25519/u,
  );
});
