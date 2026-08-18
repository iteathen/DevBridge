import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolProfile, expandProfileArgs } from '../src/runtime/cli-profile.js';
import { PolicyError } from '../src/errors.js';

test('sandbox declarations do not grant enforcement and verified containment is required by default', () => {
  const profile = validateToolProfile('tool', { executable: 'tool', args: [] });
  assert.equal(profile.sandbox.declaredEnforcement, 'none');
  assert.equal(profile.sandbox.requiresVerifiedSandbox, true);
  assert.throws(() => validateToolProfile('unsafe', {
    executable: 'tool',
    args: [],
    sandbox: { requiresVerifiedSandbox: false }
  }), PolicyError);
  assert.equal(validateToolProfile('unsafe-dev', {
    executable: 'tool',
    args: [],
    sandbox: { requiresVerifiedSandbox: false }
  }, { allowUncontainedTools: true }).sandbox.requiresVerifiedSandbox, false);
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

test('shell-like executables need an explicit local exception', () => {
  assert.throws(() => validateToolProfile('shell', {
    executable: 'bash',
    args: [],
    sandbox: { enforcement: 'tool' }
  }), PolicyError);
});
