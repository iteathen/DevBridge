import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { environmentLifecycleAuthorityLayout } from '../src/runtime/environment-lifecycle-authority-layout.js';
import { environmentLifecycleAuthorityIdentity } from '../src/runtime/environment-lifecycle-authority-transport.js';


test('Windows authority layout derives a protected ProgramData owner from ordinary endpoint state', () => {
  const stateDirectory = 'C:\\Users\\operator\\.devbridge\\state';
  const identity = environmentLifecycleAuthorityIdentity(stateDirectory, { platform: 'win32' });
  const layout = environmentLifecycleAuthorityLayout({
    stateDirectory,
    platform: 'win32',
    environment: { ProgramData: 'D:\\ProgramData', SystemDrive: 'D:' },
  });

  assert.equal(layout.authorityIdentity, identity);
  assert.equal(layout.endpointStateDirectory, path.win32.resolve(stateDirectory));
  assert.equal(layout.protectedRoot, path.win32.join('D:\\ProgramData', 'DevBridge', 'lifecycle-authority', identity));
  assert.equal(layout.codeDirectory, path.win32.join(layout.protectedRoot, 'code'));
  assert.equal(layout.protectedStateDirectory, path.win32.join(layout.protectedRoot, 'state'));
  assert.equal(layout.taskPath, `\\DevBridge\\LifecycleAuthority\\${identity}`);
  assert.equal(layout.serviceName, null);
  assert.equal(layout.runDirectory, null);
  assert.equal(layout.protectedRoot.toLowerCase().startsWith(path.win32.resolve(stateDirectory).toLowerCase()), false);
});


test('Linux authority layout separates protected persistent and runtime ownership', () => {
  const stateDirectory = '/home/operator/.devbridge/state';
  const identity = environmentLifecycleAuthorityIdentity(stateDirectory, { platform: 'linux' });
  const layout = environmentLifecycleAuthorityLayout({ stateDirectory, platform: 'linux' });

  assert.equal(layout.authorityIdentity, identity);
  assert.equal(layout.endpointStateDirectory, path.posix.resolve(stateDirectory));
  assert.equal(layout.protectedRoot, `/var/lib/devbridge/lifecycle-authority/${identity}`);
  assert.equal(layout.codeDirectory, `${layout.protectedRoot}/code`);
  assert.equal(layout.protectedStateDirectory, `${layout.protectedRoot}/state`);
  assert.equal(layout.serviceName, `devbridge-lifecycle-authority-${identity}.service`);
  assert.equal(layout.runDirectory, '/run/devbridge');
  assert.equal(layout.taskPath, null);
});


test('authority layout permits explicit protected roots for disposable qualification only', () => {
  const windows = environmentLifecycleAuthorityLayout({
    stateDirectory: 'C:\\DevBridge\\state',
    platform: 'win32',
    protectedRoot: 'C:\\DevBridge-Qualification\\authority',
  });
  assert.equal(windows.protectedRoot, 'C:\\DevBridge-Qualification\\authority');

  const linux = environmentLifecycleAuthorityLayout({
    stateDirectory: '/srv/devbridge/state',
    platform: 'linux',
    protectedRoot: '/tmp/devbridge-qualification/authority',
    runDirectory: '/tmp/devbridge-qualification/run',
  });
  assert.equal(linux.protectedRoot, '/tmp/devbridge-qualification/authority');
  assert.equal(linux.runDirectory, '/tmp/devbridge-qualification/run');
});


test('authority layout rejects relative roots and unsupported hosts', () => {
  assert.throws(() => environmentLifecycleAuthorityLayout({ stateDirectory: 'relative', platform: 'win32' }), /must be an absolute/u);
  assert.throws(() => environmentLifecycleAuthorityLayout({ stateDirectory: '/tmp/state', platform: 'darwin' }), /unsupported/u);
  assert.throws(() => environmentLifecycleAuthorityLayout({ stateDirectory: '/tmp/state', platform: 'linux', protectedRoot: 'relative' }), /must be an absolute/u);
});
