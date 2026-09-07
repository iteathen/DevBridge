import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  reconcileWindowsInstallMediaSetup,
  resolveWindowsInstallMediaSetup,
} from '../src/app/windows-install-media-setup.js';

function inspectionResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    stdout: JSON.stringify({
      ok: true,
      container: 'wim',
      images: [
        {
          index: 6,
          name: 'Windows 11 Pro',
          edition: 'Professional',
          architecture: 'amd64',
          version: '10.0.26100.1',
          build: 26100,
          installationType: 'Client',
          languages: ['en-US'],
          defaultLanguage: 'en-US',
        },
      ],
    }),
    stderr: '',
  };
}

async function temporaryHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'devbridge-windows-media-setup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('Windows media setup state observation has no discovery side effect', async (t) => {
  const home = await temporaryHome(t);
  let invoked = false;
  const result = await reconcileWindowsInstallMediaSetup({
    home,
    stateDirectory: path.join(home, 'state'),
    platform: 'win32',
    invoke: async () => { invoked = true; return inspectionResult(); },
  });

  assert.equal(result.state, 'source-required');
  assert.equal(invoked, false);
  await assert.rejects(() => access(result.inbox), { code: 'ENOENT' });
});

test('Windows media setup discovers then separately approves exact durable authority', async (t) => {
  const home = await temporaryHome(t);
  const location = path.join(home, 'owned-windows.iso');
  await writeFile(location, 'bounded test media', 'utf8');
  const canonicalLocation = await realpath(location);
  let invocations = 0;
  const invoke = async () => { invocations += 1; return inspectionResult(); };

  const discovered = await reconcileWindowsInstallMediaSetup({
    home,
    stateDirectory: path.join(home, 'state'),
    platform: 'win32',
    invoke,
    discover: true,
    location,
  });
  assert.equal(discovered.state, 'selection-required');
  assert.equal(discovered.candidates.length, 1);
  assert.equal(JSON.stringify(discovered).includes(location), false);

  const accepted = await reconcileWindowsInstallMediaSetup({
    home,
    stateDirectory: path.join(home, 'state'),
    platform: 'win32',
    invoke,
    approval: {
      candidate: discovered.candidates[0].subject,
      imageIndex: 6,
      sourceClass: 'official-owned',
    },
  });
  assert.equal(invocations, 2);
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.accepted.image.index, 6);
  assert.equal(accepted.accepted.sourceClass, 'official-owned');
  assert.equal(accepted.accepted.temporary, false);
  assert.equal(JSON.stringify(accepted).includes(location), false);
  const resolved = await resolveWindowsInstallMediaSetup({
    home,
    stateDirectory: path.join(home, 'state'),
    platform: 'win32',
    invoke,
  });
  assert.equal(resolved.location, canonicalLocation);
  assert.equal(resolved.authority.image.index, 6);
  assert.equal(invocations, 2);
});

test('Windows media setup isolates local inspection failures behind a bounded status', async (t) => {
  const home = await temporaryHome(t);
  const location = path.join(home, 'owned-windows.iso');
  await writeFile(location, 'bounded test media', 'utf8');
  const result = await reconcileWindowsInstallMediaSetup({
    home,
    stateDirectory: path.join(home, 'state'),
    platform: 'win32',
    invoke: async () => { throw new Error(`failed at ${location}`); },
    discover: true,
    location,
  });

  assert.equal(result.state, 'source-required');
  assert.equal(result.rejectedCount, 1);
  assert.equal(JSON.stringify(result).includes(location), false);
});

test('Windows media setup remains unavailable without mutation on other hosts', async (t) => {
  const home = await temporaryHome(t);
  const result = await reconcileWindowsInstallMediaSetup({
    home,
    stateDirectory: path.join(home, 'state'),
    platform: 'linux',
    invoke: async () => inspectionResult(),
    discover: true,
  });
  assert.equal(result.state, 'platform-unavailable');
  assert.equal(result.inbox, null);
  assert.equal(await resolveWindowsInstallMediaSetup({
    home,
    stateDirectory: path.join(home, 'state'),
    platform: 'linux',
    invoke: async () => inspectionResult(),
  }), null);
});
