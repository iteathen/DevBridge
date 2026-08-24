import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { establishUbuntuReleaseAuthority } from '../src/setup/ubuntu-release-authority.js';
import { UBUNTU_SETUP_SOURCE_POLICY } from '../src/setup/ubuntu-authority.js';

function response(bytes) {
  return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
}

test('Ubuntu release authority invokes the exact setup-provided signature verifier binding', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'devbridge-release-authority-'));
  const verifier = 'C:\\Program Files\\GnuPG\\bin\\gpgv.exe';
  const manifest = Buffer.from(`${UBUNTU_SETUP_SOURCE_POLICY.mediaSha256}  ${UBUNTU_SETUP_SOURCE_POLICY.mediaName}\n`);
  const signature = Buffer.from('detached-signature-fixture');
  const keyBytes = Buffer.from('public-key-fixture');
  const armoredKey = Buffer.from([
    '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    '',
    keyBytes.toString('base64'),
    '-----END PGP PUBLIC KEY BLOCK-----',
    '',
  ].join('\n'));
  const fetches = [];
  const invocations = [];

  try {
    const result = await establishUbuntuReleaseAuthority({
      home,
      signatureVerifierExecutable: verifier,
      async fetchImpl(url) {
        fetches.push(url);
        if (url.endsWith('/SHA256SUMS')) return response(manifest);
        if (url.endsWith('/SHA256SUMS.gpg')) return response(signature);
        if (url.startsWith('https://keyserver.ubuntu.com/')) return response(armoredKey);
        throw new Error(`unexpected URL: ${url}`);
      },
      async invoke(request) {
        invocations.push(request);
        assert.equal(request.executable, verifier);
        assert.equal(request.arguments[0], '--keyring');
        assert.equal(request.arguments[2], '--status-fd');
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          stdout: `[GNUPG:] VALIDSIG ${UBUNTU_SETUP_SOURCE_POLICY.signerFingerprint} a b c d e f g h\n`,
          stderr: '',
        };
      },
    });

    assert.equal(result.verified, true);
    assert.equal(result.signerFingerprint, UBUNTU_SETUP_SOURCE_POLICY.signerFingerprint);
    assert.equal(invocations.length, 1);
    assert.equal(fetches.some((url) => url.endsWith('/SHA256SUMS')), true);
    assert.equal(fetches.some((url) => url.endsWith('/SHA256SUMS.gpg')), true);
    assert.equal(fetches.some((url) => url.startsWith('https://keyserver.ubuntu.com/')), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
