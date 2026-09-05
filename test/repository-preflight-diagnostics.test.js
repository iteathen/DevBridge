import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import preflightProgress from '../src/bootstrap/preflight-progress-reporter.mjs';
import {
  boundedProcessFailureEvidence,
} from '../src/bootstrap/repository-preflight.mjs';

test('long TAP output retains the first failing subject, assertion, and terminal summary', () => {
  const before = Array.from({ length: 80 }, (_, index) => `ok ${index + 1} - earlier passing test with padded output ${'a'.repeat(40)}`).join('\n');
  const failure = [
    'not ok 81 - exact failing subject',
    '  ---',
    "  error: 'expected durable evidence'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
  ].join('\n');
  const after = Array.from({ length: 80 }, (_, index) => `ok ${index + 82} - later passing test with padded output ${'b'.repeat(40)}`).join('\n');
  const summary = ['1..161', '# tests 161', '# pass 160', '# fail 1'].join('\n');
  const value = boundedProcessFailureEvidence({ status: 1, stdout: `${before}\n${failure}\n${after}\n${summary}`, stderr: '' }, 1200);
  assert.match(value, /not ok 81 - exact failing subject/u);
  assert.match(value, /expected durable evidence/u);
  assert.match(value, /# fail 1/u);
  assert.ok(value.length <= 1200);
});

test('native reporter composition preserves compact progress and bounded failing TAP', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'db-preflight-reporters-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const file = path.join(fixture, 'case.cjs');
  writeFileSync(file, "const test=require('node:test'); test('passed fixture',()=>{}); test('failed fixture',()=>{throw new Error('fixture assertion');});\n");
  const moduleUrl = new URL('../src/bootstrap/repository-preflight.mjs', import.meta.url).href;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = `
    import { runRepositoryPreflight } from ${JSON.stringify(moduleUrl)};
    import { spawnSync } from 'node:child_process';
    import { writeSync } from 'node:fs';
    const runner = (exe, args, options) => args[0] === '--test'
      ? spawnSync(exe, [...args.filter(a => a.startsWith('--')), ${JSON.stringify(file)}], options)
      : { status: 0 };
    try {
      runRepositoryPreflight(${JSON.stringify(root)}, runner, {}, {}, {
        onProgress: event => writeSync(2, JSON.stringify(event) + '\\n'),
      });
    } catch (error) { writeSync(2, error.message); process.exitCode = 1; }
  `;
  // This fixture starts a standalone CLI, not another participant in this
  // test runner's inherited child-process reporting protocol.
  const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10_000, shell: false, windowsHide: true, env: environment,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr.slice(-3000)}`);
  assert.match(result.stdout, /\.X/u);
  assert.doesNotMatch(result.stdout, /fixture assertion|not ok/u);
  assert.match(result.stderr, /"operation":"targeted preflight tests","status":"started"/u);
  assert.match(result.stderr, /"operation":"targeted preflight tests","status":"failed"/u);
  assert.match(result.stderr, /not ok 2 - failed fixture/u);
  assert.match(result.stderr, /fixture assertion/u);
  assert.match(result.stderr, /# fail 1/u);
});

test('native direct-child timeout returns partial evidence after that child closes', () => {
  const result = spawnSync(process.execPath, ['-e', "process.stderr.write('fixture-ready\\n'); setInterval(()=>{}, 1000)"], {
    encoding: 'utf8', timeout: 2_000, shell: false, windowsHide: true,
  });
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.status, null);
  assert.ok(result.signal);
  assert.match(boundedProcessFailureEvidence(result), /fixture-ready/u);
  // spawnSync's closed direct child is the evidence; no descendant-tree claim.
});

test('progress projection ignores payloads and bounds an arbitrarily long event stream', async () => {
  async function* events() {
    yield { type: 'test:stdout', data: { message: 'secret' } };
    yield { type: 'unknown', data: { message: 'secret' } };
    for (let index = 0; index < 20_000; index += 1) {
      yield { type: index % 2 ? 'test:pass' : 'test:fail', data: { name: 'secret', details: 'secret' } };
    }
  }
  let output = '';
  for await (const chunk of preflightProgress(events())) output += chunk;
  assert.doesNotMatch(output, /secret/u);
  assert.equal((output.match(/X/g) ?? []).length, 8192);
  assert.equal((output.match(/display capped/g) ?? []).length, 1);
  assert.ok(output.length < 18_000);
});

test('stdout failure evidence is not discarded when stderr also contains data', () => {
  const value = boundedProcessFailureEvidence({
    status: 1,
    stderr: `warning before failure ${'w'.repeat(800)}`,
    stdout: `${'p'.repeat(1200)}\nnot ok 4 - retained stdout failure\n  error: retained assertion\n${'z'.repeat(1200)}\n# fail 1`,
  }, 900);
  assert.match(value, /retained stdout failure/u);
  assert.match(value, /retained assertion/u);
  assert.match(value, /# fail 1/u);
  assert.ok(value.length <= 900);
});

test('non-TAP errors retain their bounded error neighborhood and terminal evidence', () => {
  const value = boundedProcessFailureEvidence({
    status: 2,
    stdout: `${'x'.repeat(900)}\nError: compiler exploded\ncode: ERR_TOOL_FAILURE\n${'y'.repeat(900)}\nterminal cleanup failed`,
    stderr: '',
  }, 700);
  assert.match(value, /Error: compiler exploded/u);
  assert.match(value, /ERR_TOOL_FAILURE/u);
  assert.match(value, /terminal cleanup failed/u);
  assert.ok(value.length <= 700);
});

test('small evidence remains exact and invalid bounds are rejected', () => {
  assert.equal(boundedProcessFailureEvidence({ status: 1, stderr: 'small failure', stdout: '' }), '[stderr]\nsmall failure');
  assert.throws(() => boundedProcessFailureEvidence({ status: 1, stderr: 'failure' }, 255), /bound is invalid/u);
});
