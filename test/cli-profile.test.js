import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolProfile, expandProfileArgs } from '../src/runtime/cli-profile.js';
import { PolicyError } from '../src/errors.js';

test('a profile may declare no self-sandbox because containment is enforced outside the profile', () => {
  const profile = validateToolProfile('tool', { executable: 'tool', args: [] });
  assert.equal(profile.sandbox.enforcement, 'none');
  assert.equal(profile.sandbox.outsideProjectRead, 'deny');
  assert.equal(profile.sandbox.outsideProjectWrite, false);
  assert.equal(profile.sandbox.network, 'deny');
});

test('allows only structural argv placeholders while ordinary braces stay literal local argv', () => {
  const profile = validateToolProfile('tool', {
    executable: 'tool',
    args: ['--cwd', '{projectDir}', '--context', '{contextFile}', '--literal', "const x = { name: 'fixture' };"],
    sandbox: { enforcement: 'tool', outsideProjectWrite: false }
  });
  assert.deepEqual(expandProfileArgs(profile.args, {
    projectDir: '/project', contextFile: '/project/context.json', resultFile: '/project/result.json', runId: 'r1'
  }), ['--cwd', '/project', '--context', '/project/context.json', '--literal', "const x = { name: 'fixture' };"]);

  assert.throws(() => validateToolProfile('bad', {
    executable: 'tool',
    args: ['{instructions}'],
    sandbox: { enforcement: 'tool' }
  }), /unsupported placeholder/);
});

test('outside-project writes still require an explicit local declaration exception', () => {
  assert.throws(() => validateToolProfile('write-outside', {
    executable: 'tool',
    args: [],
    sandbox: { enforcement: 'os', outsideProjectWrite: true }
  }), PolicyError);
  const declared = validateToolProfile('write-outside', {
    executable: 'tool',
    args: [],
    sandbox: { enforcement: 'os', outsideProjectWrite: true }
  }, { allowUncontainedTools: true });
  assert.equal(declared.sandbox.outsideProjectWrite, true);
});

test('shell-like executables need an explicit local exception', () => {
  assert.throws(() => validateToolProfile('shell', {
    executable: 'bash',
    args: [],
    sandbox: { enforcement: 'tool' }
  }), PolicyError);
});
