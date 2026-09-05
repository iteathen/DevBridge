import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sameFilesystemIdentity,
  sameObservedFilesystemIdentity,
} from '../src/runtime/local-filesystem-identity.js';

function identity({ device = 7n, symbolic = false, inode = 42n } = {}) {
  return Object.freeze({
    dev: device,
    ino: inode,
    isSymbolicLink: () => symbolic,
  });
}

test('Windows short and long spellings are accepted only as the same observed filesystem identity', async () => {
  const inspected = [];
  const result = await sameFilesystemIdentity(
    'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\value',
    'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\value',
    {
      platform: 'win32',
      inspect: async (location) => {
        inspected.push(location);
        return identity();
      },
    },
  );
  assert.equal(result, true);
  assert.ok(inspected.includes('C:\\Users\\RUNNER~1'));
  assert.ok(inspected.includes('C:\\Users\\runneradmin\\AppData\\Local\\Temp\\value'));
});

test('Windows identity equivalence does not accept a symbolic component on either spelling', async () => {
  for (const symbolicEntry of ['C:\\Users\\RUNNER~1', 'C:\\Users\\runneradmin']) {
    const result = await sameFilesystemIdentity(
      'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\value',
      'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\value',
      {
        platform: 'win32',
        inspect: async (location) => identity({ symbolic: location === symbolicEntry }),
      },
    );
    assert.equal(result, false);
  }
});

test('unknown Windows inode identity and non-Windows spelling changes fail closed', async () => {
  const unknown = await sameFilesystemIdentity('C:\\SHORT\\value', 'C:\\Long Name\\value', {
    platform: 'win32',
    inspect: async () => identity({ inode: 0n }),
  });
  assert.equal(unknown, false);

  let inspected = false;
  const posix = await sameFilesystemIdentity('/tmp/short/value', '/tmp/long/value', {
    platform: 'linux',
    inspect: async () => { inspected = true; return identity(); },
  });
  assert.equal(posix, false);
  assert.equal(inspected, false);
});

test('observed identity accepts a missing Windows path device only with one exact nonzero file identity', () => {
  assert.equal(sameObservedFilesystemIdentity(identity({ device: 0n }), identity({ device: 7n }), { platform: 'win32' }), true);
  assert.equal(sameObservedFilesystemIdentity(identity({ device: 7n }), identity({ device: 8n }), { platform: 'win32' }), false);
  assert.equal(sameObservedFilesystemIdentity(identity({ device: 0n }), identity({ device: 7n }), { platform: 'linux' }), false);
  assert.equal(sameObservedFilesystemIdentity(identity({ device: 0n, inode: 0n }), identity({ device: 7n, inode: 0n }), { platform: 'win32' }), false);
  assert.equal(sameObservedFilesystemIdentity(identity({ device: 0n, inode: 41n }), identity({ device: 7n }), { platform: 'win32' }), false);
});

test('Windows spelling equivalence never crosses volume roots', async () => {
  let inspected = false;
  const result = await sameFilesystemIdentity('C:\\SHORT\\value', 'D:\\Long Name\\value', {
    platform: 'win32',
    inspect: async () => { inspected = true; return identity({ device: 0n }); },
  });
  assert.equal(result, false);
  assert.equal(inspected, false);
});
