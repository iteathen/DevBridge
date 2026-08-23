import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DetachedSignatureVerifier } from '../src/runtime/detached-signature-verifier.js';

async function root() { return mkdtemp(path.join(os.tmpdir(), 'db-detached-signature-')); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function fixture() {
  const directory = await root();
  const manifest = path.join(directory, 'manifest');
  const signature = path.join(directory, 'manifest.sig');
  const keyring = path.join(directory, 'trusted.gpg');
  await writeFile(manifest, 'signed manifest\n');
  await writeFile(signature, 'signature');
  await writeFile(keyring, 'keyring');
  return { directory, manifest, signature, keyring };
}

test('detached verifier accepts the exact signing fingerprint and binds manifest bytes', async () => {
  const data = await fixture();
  const fingerprint = 'A'.repeat(40);
  try {
    const calls = [];
    const verifier = new DetachedSignatureVerifier({
      keyring: data.keyring,
      executable: 'gpgv-test',
      invoke: async (request) => {
        calls.push(request);
        return { exitCode: 0, stdout: `[GNUPG:] VALIDSIG ${fingerprint} 2026-01-01 0 0 4 0 1 10 00\n`, stderr: '', timedOut: false, aborted: false, outputTruncated: false };
      },
    });
    const result = await verifier.verify({ manifest: data.manifest, signature: data.signature, expectedFingerprint: fingerprint });
    assert.deepEqual(result, { verified: true, signerFingerprint: fingerprint, manifestSha256: sha256('signed manifest\n') });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'gpgv-test');
    assert.deepEqual(calls[0].arguments.slice(0, 3), ['--keyring', await realpath(data.keyring), '--status-fd']);
    assert.equal(calls[0].input, null);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('detached verifier accepts a pinned primary fingerprint when a signing subkey made the signature', async () => {
  const data = await fixture();
  const signing = 'B'.repeat(40);
  const primary = 'C'.repeat(40);
  try {
    const verifier = new DetachedSignatureVerifier({
      keyring: data.keyring,
      invoke: async () => ({ exitCode: 0, stdout: `[GNUPG:] VALIDSIG ${signing} 2026-01-01 0 0 4 0 1 10 00 ${primary}\n`, stderr: '', timedOut: false, aborted: false, outputTruncated: false }),
    });
    const result = await verifier.verify({ manifest: data.manifest, signature: data.signature, expectedFingerprint: primary });
    assert.equal(result.signerFingerprint, primary);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('detached verifier rejects a different signer even when the process exits successfully', async () => {
  const data = await fixture();
  try {
    const verifier = new DetachedSignatureVerifier({
      keyring: data.keyring,
      invoke: async () => ({ exitCode: 0, stdout: `[GNUPG:] VALIDSIG ${'D'.repeat(40)} 2026-01-01 0 0 4 0 1 10 00\n`, stderr: '', timedOut: false, aborted: false, outputTruncated: false }),
    });
    await assert.rejects(() => verifier.verify({ manifest: data.manifest, signature: data.signature, expectedFingerprint: 'E'.repeat(40) }), /does not match authority/u);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});

test('detached verifier rejects explicit signature failure status and process failure', async () => {
  const data = await fixture();
  try {
    const failedStatus = new DetachedSignatureVerifier({
      keyring: data.keyring,
      invoke: async () => ({ exitCode: 0, stdout: `[GNUPG:] BADSIG ${'F'.repeat(40)} signer\n`, stderr: '', timedOut: false, aborted: false, outputTruncated: false }),
    });
    await assert.rejects(() => failedStatus.verify({ manifest: data.manifest, signature: data.signature, expectedFingerprint: 'F'.repeat(40) }), /failed signature|valid signature/u);

    const failedProcess = new DetachedSignatureVerifier({
      keyring: data.keyring,
      invoke: async () => ({ exitCode: 2, stdout: '', stderr: 'bad signature', timedOut: false, aborted: false, outputTruncated: false }),
    });
    await assert.rejects(() => failedProcess.verify({ manifest: data.manifest, signature: data.signature, expectedFingerprint: 'F'.repeat(40) }), /bad signature/u);
  } finally { await rm(data.directory, { recursive: true, force: true }); }
});
