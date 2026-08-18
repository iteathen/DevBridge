import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const SYNTAX_FILES = [
  'patch-poller.mjs',
  'src/cli.js',
  'src/config.js',
  'src/app/runtime.js',
  'src/app/chat-handoff.js',
  'src/context/chat-handoff.js',
  'src/context/context-budget.js',
  'src/run/controller-plan.js',
  'src/run/run-coordinator.js',
  'src/runtime/deterministic-process-runner.js',
  'src/bootstrap/transactional-bootstrap.mjs',
];

const JSON_FILES = [
  'package.json',
  'config/patch-poller.example.json',
];

const TARGETED_TESTS = [
  'test/config.test.js',
  'test/chat-handoff.test.js',
  'test/chat-handoff-app.test.js',
  'test/context-budget.test.js',
  'test/controller-plan.test.js',
  'test/runtime-activation.test.js',
  'test/rate-budget.test.js',
];

function checked(runner, args, { cwd, label, timeoutMs }) {
  const result = runner(process.execPath, args, {
    cwd,
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed (exit ${result.status ?? 'spawn-error'})${detail ? `: ${detail.slice(-4000)}` : ''}`);
  }
}

export function runRepositoryPreflight(root = process.cwd(), runner = spawnSync) {
  const cwd = path.resolve(root);
  for (const relative of SYNTAX_FILES) {
    const file = path.join(cwd, relative);
    if (!existsSync(file)) throw new Error(`preflight required file is missing: ${relative}`);
    checked(runner, ['--check', file], { cwd, label: `syntax ${relative}`, timeoutMs: 60_000 });
  }

  for (const relative of JSON_FILES) {
    const file = path.join(cwd, relative);
    if (!existsSync(file)) throw new Error(`preflight required JSON is missing: ${relative}`);
    try { JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`JSON ${relative} is invalid: ${error.message}`, { cause: error }); }
  }

  const targeted = TARGETED_TESTS.filter((relative) => existsSync(path.join(cwd, relative)));
  if (targeted.length !== TARGETED_TESTS.length) {
    const missing = TARGETED_TESTS.filter((relative) => !targeted.includes(relative));
    throw new Error(`preflight targeted tests are missing: ${missing.join(', ')}`);
  }
  checked(runner, ['--test', ...targeted], { cwd, label: 'targeted preflight tests', timeoutMs: 180_000 });

  return {
    syntaxFiles: SYNTAX_FILES.length,
    jsonFiles: JSON_FILES.length,
    targetedTests: targeted.length,
  };
}

const thisFile = path.resolve(fileURLToPath(import.meta.url));
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryFile === thisFile) {
  try {
    const result = runRepositoryPreflight();
    process.stdout.write(`${JSON.stringify({ status: 'passed', ...result })}\n`);
  } catch (error) {
    process.stderr.write(`[patch-poller-preflight] ${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
