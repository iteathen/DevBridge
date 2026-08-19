import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGitHubCredential,
  publicGitHubCredentialStatus,
} from '../src/github/auth-provider.js';

const auth = Object.freeze({
  mode: 'auto',
  environmentVariables: [
    'DEVBRIDGE_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ],
  githubCliExecutable: 'gh',
  hostname: 'github.com',
});

test('GitHub auth prefers DevBridge then GH_TOKEN then GITHUB_TOKEN', async () => {
  let githubCliCalled = false;
  const credential = await resolveGitHubCredential(auth, {
    env: {
      DEVBRIDGE_GITHUB_TOKEN: 'first-token',
      GH_TOKEN: 'second-token',
      GITHUB_TOKEN: 'third-token',
    },
    githubCliTokenResolver: async () => {
      githubCliCalled = true;
      return 'unexpected-token';
    },
  });

  assert.equal(credential.provider, 'environment');
  assert.equal(credential.source, 'DEVBRIDGE_GITHUB_TOKEN');
  assert.equal(credential.token, 'first-token');
  assert.equal(githubCliCalled, false);
});

test('GitHub auth falls through environment names in configured order', async () => {
  const credential = await resolveGitHubCredential(auth, {
    env: { GITHUB_TOKEN: 'github-token' },
    githubCliTokenResolver: async () => 'unexpected-token',
  });
  assert.equal(credential.provider, 'environment');
  assert.equal(credential.source, 'GITHUB_TOKEN');
  assert.equal(credential.token, 'github-token');
});

test('GitHub auth auto mode can reuse an authenticated GitHub CLI credential', async () => {
  let request = null;
  const credential = await resolveGitHubCredential(auth, {
    env: {},
    githubCliTokenResolver: async (options) => {
      request = options;
      return 'cli-token';
    },
  });
  assert.equal(credential.provider, 'github-cli');
  assert.equal(credential.source, 'github-cli:github.com');
  assert.equal(credential.token, 'cli-token');
  assert.equal(request.executable, 'gh');
  assert.equal(request.hostname, 'github.com');
});

test('environment-only GitHub auth never invokes GitHub CLI', async () => {
  let githubCliCalled = false;
  const credential = await resolveGitHubCredential(
    { ...auth, mode: 'environment' },
    {
      env: {},
      githubCliTokenResolver: async () => {
        githubCliCalled = true;
        return 'unexpected-token';
      },
    },
  );
  assert.equal(credential, null);
  assert.equal(githubCliCalled, false);
});

test('public GitHub auth status never contains the credential value', async () => {
  const credential = await resolveGitHubCredential(auth, {
    env: { GH_TOKEN: 'do-not-report-this-secret' },
    githubCliTokenResolver: async () => null,
  });
  const status = publicGitHubCredentialStatus(auth, credential);
  assert.equal(status.available, true);
  assert.equal(status.provider, 'environment');
  assert.equal(status.source, 'GH_TOKEN');
  assert.equal(JSON.stringify(status).includes('do-not-report-this-secret'), false);
});
