import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitClient } from '../src/git/git-client.js';

test('uses a synthetic Git home instead of inheriting user Git configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pp-git-client-'));
  const hostileHome = path.join(root, 'host-home');
  const syntheticHome = path.join(root, 'synthetic-home');
  await mkdir(hostileHome, { recursive: true });
  await writeFile(path.join(hostileHome, '.gitconfig'), '[user]\n\tname = SHOULD-NOT-LEAK\n');
  const git = new GitClient({
    syntheticHome,
    sourceEnv: { ...process.env, HOME: hostileHome, USERPROFILE: hostileHome },
    allowFileProtocol: true
  });
  assert.match(await git.version(), /^git version /);
  const result = await git.run(['config', '--global', '--get', 'user.name'], { allowFailure: true });
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /SHOULD-NOT-LEAK/);
});
