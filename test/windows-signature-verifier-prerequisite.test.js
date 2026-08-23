import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { reconcileWindowsSignatureVerifier } from '../src/setup/windows-signature-verifier-prerequisite.js';

function success(value = '') {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
  };
}

function fixturePolicy(bytes, overrides = {}) {
  return {
    url: 'https://example.invalid/approved-verifier.exe',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    fileName: 'approved-verifier.exe',
    maxBytes: 1024 * 1024,
    ...overrides,
  };
}

const VERIFIER = 'C:\\Program Files\\GnuPG\\bin\\gpgv.exe';

test('existing Windows signature verifier is reused without package mutation', async () => {
  let fetchCalls = 0;
  let installerCalls = 0;
  const result = await reconcileWindowsSignatureVerifier({
    environment: {},
    async fetchImpl() {
      fetchCalls += 1;
      throw new Error('package fetch must not run');
    },
    async invoke(request) {
      if (request.executable === 'powershell.exe') return success({ elevated: false, executable: VERIFIER });
      if (request.executable === VERIFIER) return success('gpgv ready');
      installerCalls += 1;
      throw new Error('installer must not run');
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.changed, false);
  assert.equal(result.executable, VERIFIER);
  assert.equal(fetchCalls, 0);
  assert.equal(installerCalls, 0);
});

test('missing Windows signature verifier stops at elevation before download or mutation', async () => {
  let fetchCalls = 0;
  const result = await reconcileWindowsSignatureVerifier({
    environment: {},
    async fetchImpl() {
      fetchCalls += 1;
      throw new Error('package fetch must not run before elevation');
    },
    async invoke(request) {
      assert.equal(request.executable, 'powershell.exe');
      return success({ elevated: false, executable: null });
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.changed, false);
  assert.match(result.blocker, /elevated PowerShell/u);
  assert.equal(fetchCalls, 0);
});

test('elevated Windows setup installs the exact approved package, re-observes the verifier, and cleans the installer', async () => {
  const bytes = Buffer.from('approved signature verifier package fixture');
  const policy = fixturePolicy(bytes);
  let installed = false;
  let installerPath = null;
  let installerCalls = 0;
  let fetchCalls = 0;

  const result = await reconcileWindowsSignatureVerifier({
    environment: {},
    policy,
    async fetchImpl(url, options) {
      fetchCalls += 1;
      assert.equal(url, policy.url);
      assert.deepEqual(options, { redirect: 'error' });
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    },
    async invoke(request) {
      if (request.executable === 'powershell.exe') {
        return success({ elevated: true, executable: installed ? VERIFIER : null });
      }
      if (request.executable === VERIFIER) return success('gpgv ready');
      installerCalls += 1;
      installerPath = request.executable;
      assert.equal(request.executable.endsWith(policy.fileName), true);
      assert.deepEqual(request.arguments, ['/S']);
      installed = true;
      return success();
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(result.executable, VERIFIER);
  assert.equal(fetchCalls, 1);
  assert.equal(installerCalls, 1);
  assert.ok(installerPath);
  await assert.rejects(access(installerPath), /ENOENT/u);
});

test('approved package digest mismatch fails closed before installer execution', async () => {
  const bytes = Buffer.from('tampered package fixture');
  const policy = fixturePolicy(Buffer.from('different approved bytes'));
  let installerCalls = 0;

  const result = await reconcileWindowsSignatureVerifier({
    environment: {},
    policy,
    async fetchImpl() {
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    },
    async invoke(request) {
      if (request.executable === 'powershell.exe') return success({ elevated: true, executable: null });
      installerCalls += 1;
      return success();
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.changed, false);
  assert.match(result.blocker, /digest does not match runtime-owned source policy/u);
  assert.equal(installerCalls, 0);
});

test('successful package execution does not claim readiness until the verifier itself is usable', async () => {
  const bytes = Buffer.from('approved package but missing verifier fixture');
  const policy = fixturePolicy(bytes);
  let installerCalls = 0;

  const result = await reconcileWindowsSignatureVerifier({
    environment: {},
    policy,
    async fetchImpl() {
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    },
    async invoke(request) {
      if (request.executable === 'powershell.exe') return success({ elevated: true, executable: null });
      installerCalls += 1;
      return success();
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.changed, true);
  assert.match(result.blocker, /installed, but the verifier is not usable/u);
  assert.equal(installerCalls, 1);
});
