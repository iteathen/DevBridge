import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ENTRIES = [
  'native-compiler-probe-cli.js',
  'chat-c-project-probe-cli.js',
  'lifecycle-roundtrip-probe-cli.js',
  'transient-recovery-probe-cli.js',
];

function execute(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8_192) child.kill(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 8_192) child.kill(); });
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end('{}\n');
  });
}

test('every built-in executable entrypoint instantiates and follows its bounded input-error path', async () => {
  for (const name of ENTRIES) {
    const file = fileURLToPath(new URL(`../src/runtime/${name}`, import.meta.url));
    const result = await execute(file);
    assert.equal(result.signal, null, `${name} must exit without forced termination`);
    assert.equal(result.code, 1, `${name} must reject malformed context`);
    assert.equal(result.stdout.length, 0);
    assert.ok(result.stderr.length > 0 && result.stderr.length <= 2_000, `${name} error output must be bounded`);
  }
});

test('built-in entrypoints depend only on their local result action', async () => {
  for (const name of ENTRIES) {
    const source = await readFile(fileURLToPath(new URL(`../src/runtime/${name}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /worker-exchange|WORKER_RESULT_FILE|resultFile|controlContext|controlResult/iu, name);
    assert.match(source, /emitResult/u, name);
  }
});
