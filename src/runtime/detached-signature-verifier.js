import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';

const FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/u;
const FAILURE_STATUS = new Set(['BADSIG', 'ERRSIG', 'NO_PUBKEY', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG']);

async function regularFile(location, name) {
  if (typeof location !== 'string' || location.length === 0 || location.includes('\0')) throw new TypeError(`${name} is invalid`);
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a real regular file`);
  return realpath(location);
}

async function sha256File(location) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(location);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function statusRecords(stdout) {
  const records = [];
  for (const raw of String(stdout ?? '').split(/\r?\n/u)) {
    if (!raw.startsWith('[GNUPG:] ')) continue;
    const fields = raw.slice('[GNUPG:] '.length).trim().split(/\s+/u);
    if (fields.length > 0) records.push(fields);
  }
  return records;
}

export class DetachedSignatureVerifier {
  #invoke;
  #executable;
  #keyring;

  constructor({ invoke, keyring, executable = process.platform === 'win32' ? 'gpgv.exe' : 'gpgv' } = {}) {
    if (typeof invoke !== 'function') throw new TypeError('signature verification invocation contract is invalid');
    if (typeof keyring !== 'string' || keyring.length === 0) throw new TypeError('signature verification keyring is required');
    if (typeof executable !== 'string' || executable.length === 0 || executable.includes('\0')) throw new TypeError('signature verification executable is invalid');
    this.#invoke = invoke;
    this.#executable = executable;
    this.#keyring = keyring;
  }

  async verify({ manifest, signature, expectedFingerprint } = {}) {
    if (typeof expectedFingerprint !== 'string' || !FINGERPRINT.test(expectedFingerprint)) throw new TypeError('expected signature fingerprint is invalid');
    const [manifestFile, signatureFile, keyringFile] = await Promise.all([
      regularFile(manifest, 'signature manifest'),
      regularFile(signature, 'detached signature'),
      regularFile(this.#keyring, 'signature keyring'),
    ]);

    const result = await this.#invoke({
      executable: this.#executable,
      arguments: ['--keyring', keyringFile, '--status-fd', '1', signatureFile, manifestFile],
      input: null,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (!result || result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated) {
      throw new Error(String(result?.stderr || result?.stdout || 'detached signature verification failed').trim().slice(0, 2048));
    }

    const records = statusRecords(result.stdout);
    if (records.some((entry) => FAILURE_STATUS.has(entry[0]))) throw new Error('detached signature verification reported a failed signature');
    const valid = records.filter((entry) => entry[0] === 'VALIDSIG');
    if (valid.length !== 1 || valid[0].length < 10) throw new Error('detached signature verification did not report one valid signature');
    const signingFingerprint = valid[0][1];
    const primaryFingerprint = valid[0][10] ?? signingFingerprint;
    if (![signingFingerprint, primaryFingerprint].includes(expectedFingerprint)) throw new Error('detached signature signer fingerprint does not match authority');

    return Object.freeze({
      verified: true,
      signerFingerprint: expectedFingerprint,
      manifestSha256: await sha256File(manifestFile),
    });
  }
}

export function createDetachedSignatureVerifier(options) {
  const verifier = new DetachedSignatureVerifier(options);
  return (request) => verifier.verify(request);
}
