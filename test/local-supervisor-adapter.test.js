import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { stage0InstallationTag } from '../devbridge.mjs';
import {
  acquireInstallationOwner,
  backgroundChildOptions,
  installationIdentity,
  installationTag,
  observeInstallationOwner,
  requestInstallationOwnerStop,
} from '../src/bootstrap/local-supervisor-adapter.mjs';

async function tempHome(label) {
  return mkdtemp(path.join(os.tmpdir(), label));
}

test('installation identity and visible tag are stable for one canonical home', async () => {
  const home = await tempHome('db-supervisor-id-');
  const first = installationIdentity(home);
  const second = installationIdentity(path.join(home, '.'));
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(first.includes(home), false);
  assert.equal(installationTag(home), installationTag(path.join(home, '.')));
  assert.equal(installationTag(home), stage0InstallationTag(home));
  assert.match(installationTag(home), /^DB-[0-9A-F]{12}$/u);
  assert.equal(installationTag(home).includes(home), false);
  const other = await tempHome('db-supervisor-id-other-');
  assert.notEqual(installationTag(home), installationTag(other));
});

test('one live installation owner excludes a second owner and exposes path-free status', async () => {
  const home = await tempHome('db-supervisor-owner-');
  const first = await acquireInstallationOwner(home);
  try {
    const observed = await observeInstallationOwner(home);
    assert.equal(observed.claimed, true);
    assert.equal(observed.live, true);
    assert.equal(observed.pid, process.pid);
    assert.equal(observed.generation, first.generation);
    assert.equal(JSON.stringify(observed).includes(home), false);
    await assert.rejects(acquireInstallationOwner(home), /already owns installation/u);
  } finally {
    await first.release();
  }
  assert.deepEqual(await observeInstallationOwner(home), {
    installation: installationIdentity(home),
    claimed: false,
    live: false,
  });
});

test('authenticated installation stop request aborts exact live generation before release', async () => {
  const home = await tempHome('db-supervisor-stop-');
  const owner = await acquireInstallationOwner(home);
  const stopping = requestInstallationOwnerStop(home, { stopTimeoutMs: 2000 });
  await new Promise((resolve) => owner.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(owner.signal.aborted, true);
  await owner.release();
  const result = await stopping;
  assert.equal(result.requested, true);
  assert.equal(result.stopped, true);
  assert.equal(result.generation, owner.generation);
});


test('dead owner recovery reclaims stale claim and endpoint before admitting a new generation', async () => {
  const home = await tempHome('db-supervisor-dead-');
  const moduleUrl = pathToFileURL(path.resolve('src/bootstrap/local-supervisor-adapter.mjs')).href;
  const script = `import { acquireInstallationOwner } from ${JSON.stringify(moduleUrl)}; const owner = await acquireInstallationOwner(${JSON.stringify(home)}); process.stdout.write(owner.generation); process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^[0-9a-f-]{36}$/iu);

  const replacement = await acquireInstallationOwner(home);
  try {
    assert.notEqual(replacement.generation, child.stdout);
    const observed = await observeInstallationOwner(home);
    assert.equal(observed.live, true);
    assert.equal(observed.generation, replacement.generation);
  } finally {
    await replacement.release();
  }
});

test('serialized concurrent acquisition admits at most one live generation', async () => {
  const home = await tempHome('db-supervisor-race-');
  const results = await Promise.allSettled([
    acquireInstallationOwner(home),
    acquireInstallationOwner(home),
  ]);
  const winners = results.filter((result) => result.status === 'fulfilled');
  const losers = results.filter((result) => result.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  await winners[0].value.release();
});

test('background launch options hide the Windows child console without changing explicit foreground callers', () => {
  const options = backgroundChildOptions({ cwd: '/runtime', stdio: 'inherit', shell: false, windowsHide: false });
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio, 'inherit');
  assert.equal(options.cwd, '/runtime');
});
