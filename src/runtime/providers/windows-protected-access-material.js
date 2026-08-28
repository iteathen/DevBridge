import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const WINDOWS_PROTECTED_ACCESS_MATERIAL_PROTOCOL = 'devbridge/windows-protected-access-material-v1';

const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROTECTED = /^[A-Za-z0-9+/]+={0,2}$/u;
const MAX_PROTECTED_BYTES = 64 * 1024;

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security -ErrorAction Stop
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$plain = [Convert]::FromBase64String([string]$data.value)
$entropySource = [Text.Encoding]::UTF8.GetBytes('devbridge/windows-protected-access-material-v1:' + [string]$data.identity)
$algorithm = [Security.Cryptography.SHA256]::Create()
try {
  $entropy = $algorithm.ComputeHash($entropySource)
  $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  @{ protected = [Convert]::ToBase64String($protected) } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
  if ($null -ne $entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
  $algorithm.Dispose()
}
`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security -ErrorAction Stop
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$protected = [Convert]::FromBase64String([string]$data.protected)
$entropySource = [Text.Encoding]::UTF8.GetBytes('devbridge/windows-protected-access-material-v1:' + [string]$data.identity)
$algorithm = [Security.Cryptography.SHA256]::Create()
try {
  $entropy = $algorithm.ComputeHash($entropySource)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  @{ value = [Convert]::ToBase64String($plain) } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
  if ($null -ne $entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
  $algorithm.Dispose()
}
`;

function encodedScript(source) { return Buffer.from(source, 'utf16le').toString('base64'); }

function subject(value) {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError('protected access identity is invalid');
  return value;
}

function digest(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function fileName(identity) { return `${digest(identity).slice(0, 32)}.json`; }

function normalizeRecord(raw, identity) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('protected access record is invalid');
  const allowed = new Set(['protocol', 'identity', 'user', 'revision', 'protectedSecret', 'secretDigest']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`protected access record.${key} is not allowed`);
  if (raw.protocol !== WINDOWS_PROTECTED_ACCESS_MATERIAL_PROTOCOL || raw.identity !== identity || raw.user !== 'Administrator' || raw.revision !== 1) throw new Error('protected access record identity changed');
  if (typeof raw.protectedSecret !== 'string' || !PROTECTED.test(raw.protectedSecret) || Buffer.byteLength(raw.protectedSecret, 'utf8') > MAX_PROTECTED_BYTES) throw new Error('protected access record is invalid');
  if (typeof raw.secretDigest !== 'string' || !SHA256.test(raw.secretDigest)) throw new Error('protected access record is invalid');
  return { ...raw };
}

function parseInvocation(raw, field) {
  if (!raw || raw.exitCode !== 0 || raw.timedOut || raw.aborted || raw.outputTruncated) throw new Error('protected access operation failed');
  let result;
  try { result = JSON.parse(String(raw.stdout ?? '')); } catch { throw new Error('protected access operation returned invalid output'); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || typeof result[field] !== 'string') throw new Error('protected access operation returned invalid output');
  return result[field];
}

function normalizeSecret(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)
    || !/[A-Z]/u.test(value) || !/[a-z]/u.test(value) || !/[0-9]/u.test(value) || !/[^A-Za-z0-9]/u.test(value)) {
    throw new Error('protected access secret is invalid');
  }
  return value;
}

function generatedSecret(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error('protected access entropy source is invalid');
  return normalizeSecret(`Db!A9-${bytes.toString('base64url')}`);
}

export class WindowsProtectedAccessMaterial {
  #directory;
  #invoke;
  #platform;
  #entropy;

  constructor({ directory, invoke, platform = process.platform, entropy = () => randomBytes(32) } = {}) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0') || !path.isAbsolute(directory)) throw new TypeError('protected access directory is invalid');
    if (typeof invoke !== 'function') throw new TypeError('protected access invocation contract is invalid');
    if (typeof entropy !== 'function') throw new TypeError('protected access entropy contract is invalid');
    this.#directory = path.resolve(directory);
    this.#invoke = invoke;
    this.#platform = platform;
    this.#entropy = entropy;
  }

  async #ensureRoot() {
    if (this.#platform !== 'win32') throw new Error('protected access material is unavailable on this host');
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('protected access root is not a real directory');
  }

  #location(identity) { return path.join(this.#directory, fileName(identity)); }

  async #invokeProtection(script, input, field) {
    return parseInvocation(await this.#invoke({
      executable: POWERSHELL,
      arguments: [...POWERSHELL_ARGS, encodedScript(script)],
      input: JSON.stringify(input),
      timeoutMs: 30_000,
      maxOutputBytes: 128 * 1024,
    }), field);
  }

  async #load(identity) {
    let text;
    try { text = await readFile(this.#location(identity), 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    let value;
    try { value = JSON.parse(text); } catch { throw new Error('protected access record is invalid'); }
    return normalizeRecord(value, identity);
  }

  async ensure(rawIdentity) {
    const identity = subject(rawIdentity);
    await this.#ensureRoot();
    const existing = await this.#load(identity);
    if (existing) return Object.freeze({ identity, user: existing.user, created: false });
    const secret = generatedSecret(this.#entropy());
    const encoded = Buffer.from(secret, 'utf8').toString('base64');
    const protectedSecret = await this.#invokeProtection(PROTECT_SCRIPT, { identity, value: encoded }, 'protected');
    if (!PROTECTED.test(protectedSecret) || Buffer.byteLength(protectedSecret, 'utf8') > MAX_PROTECTED_BYTES) throw new Error('protected access operation returned invalid output');
    const record = {
      protocol: WINDOWS_PROTECTED_ACCESS_MATERIAL_PROTOCOL,
      identity,
      user: 'Administrator',
      revision: 1,
      protectedSecret,
      secretDigest: digest(secret),
    };
    const location = this.#location(identity);
    const temporary = `${location}.${process.pid}.pending`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      try { await rename(temporary, location); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
    const admitted = await this.#load(identity);
    if (!admitted) throw new Error('protected access record was not admitted');
    return Object.freeze({ identity, user: admitted.user, created: true });
  }

  async resolve(rawIdentity) {
    const identity = subject(rawIdentity);
    await this.#ensureRoot();
    const record = await this.#load(identity);
    if (!record) throw new Error('protected access material is unavailable');
    const encoded = await this.#invokeProtection(UNPROTECT_SCRIPT, { identity, protected: record.protectedSecret }, 'value');
    let secret;
    try { secret = Buffer.from(encoded, 'base64').toString('utf8'); } catch { throw new Error('protected access operation returned invalid output'); }
    normalizeSecret(secret);
    if (digest(secret) !== record.secretDigest) throw new Error('protected access material integrity changed');
    return Object.freeze({ user: record.user, secret });
  }

  async discard(rawIdentity) {
    const identity = subject(rawIdentity);
    await this.#ensureRoot();
    const location = this.#location(identity);
    let info;
    try { info = await lstat(location); }
    catch (error) { if (error?.code === 'ENOENT') return Object.freeze({ identity, discarded: false }); throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('protected access record is not an owned regular file');
    await rm(location, { force: false });
    return Object.freeze({ identity, discarded: true });
  }
}

export function createWindowsProtectedAccessMaterial(options) {
  return new WindowsProtectedAccessMaterial(options);
}
