import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { comparePackageVersions } from '../src/setup/package-version.js';

const ORDERED = Object.freeze([
  '1.0~~',
  '1.0~~a',
  '1.0~',
  '1.0',
  '1.0-1',
  '1.0-2',
  '1.0a',
  '1.0+1',
  '1:1.0-1',
  '2:0.1-1',
]);

test('package version comparison follows the documented epoch, revision, tilde, lexical, and numeric ordering', () => {
  for (let index = 1; index < ORDERED.length; index += 1) {
    const lower = ORDERED[index - 1];
    const higher = ORDERED[index];
    assert.equal(comparePackageVersions(lower, higher), -1, `${lower} < ${higher}`);
    assert.equal(comparePackageVersions(higher, lower), 1, `${higher} > ${lower}`);
  }
  assert.equal(comparePackageVersions('1.01', '1.001'), 0);
  assert.equal(comparePackageVersions('1.0', '1.0-0'), 0);
  assert.equal(comparePackageVersions('3.5.5-1ubuntu3.3', '3.5.5-1ubuntu3'), 1);
  assert.equal(comparePackageVersions('1:2.53.0-1ubuntu1', '2.53.0-9ubuntu9'), 1);
});

test('package version comparison fails closed on malformed values', () => {
  assert.throws(() => comparePackageVersions('1.0!', '1.0'), /left package version is invalid/u);
  assert.throws(() => comparePackageVersions('1.0', ''), /right package version is invalid/u);
  assert.throws(() => comparePackageVersions('x:1.0', '1.0'), /left package version is invalid/u);
  assert.throws(() => comparePackageVersions('1.0-', '1.0'), /left package version is invalid/u);
});

test('package version comparison agrees with dpkg for the fixed qualification corpus', { skip: process.platform !== 'linux' }, () => {
  for (const left of ORDERED) {
    for (const right of ORDERED) {
      const expected = Math.sign(comparePackageVersions(left, right));
      const relation = expected < 0 ? 'lt' : expected > 0 ? 'gt' : 'eq';
      const result = spawnSync('dpkg', ['--compare-versions', left, relation, right], { shell: false, stdio: 'ignore' });
      assert.equal(result.status, 0, `${left} ${relation} ${right}`);
    }
  }
});
