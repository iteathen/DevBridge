import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const SYNTAX_FILES = [
  'devbridge.mjs',
  'src/cli.js',
  'src/config.js',
  'src/errors.js',
  'src/app/runtime.js',
  'src/app/runtime-execution.js',
  'src/app/repository-execution.js',
  'src/app/fast-host-repository-execution.js',
  'src/app/doctor.js',
  'src/app/chat-handoff.js',
  'src/context/chat-handoff.js',
  'src/context/context-budget.js',
  'src/github/chat-handoff-projector.js',
  'src/run/controller-plan.js',
  'src/run/run-coordinator.js',
  'src/runtime/repository-execution.js',
  'src/runtime/daemon-lock.js',
  'src/runtime/persistent-environments.js',
  'src/runtime/repository-environment-execution.js',
  'src/runtime/file-tree-transfer.js',
  'src/guest/workspace-agent.mjs',
  'src/guest/environment-bootstrap-agent.mjs',
  'src/runtime/result-json.js',
  'src/runtime/result-emission.js',
  'src/runtime/work-runner.js',
  'src/app/work-runner-composition.js',
  'src/app/builtin-helper-resolver.js',
  'src/runtime/native-compiler-probe-cli.js',
  'src/runtime/chat-c-project-probe-cli.js',
  'src/runtime/lifecycle-roundtrip-probe-cli.js',
  'src/runtime/transient-recovery-probe-cli.js',
  'src/runtime/worker-exchange.js',
  'src/runtime/deterministic-operation-security.js',
  'src/runtime/deterministic-process-runner.js',
  'src/runtime/local-operation-manifest.js',
  'src/runtime/cli-help-parser.js',
  'src/runtime/tool-onboarding-policy.js',
  'src/runtime/external-directory.js',
  'src/runtime/tool-onboarding.js',
  'src/app/tool-onboarding-composition.js',
  'src/values/project-relative-path.js',
  'src/bootstrap/candidate-validator.mjs',
  'src/bootstrap/elevated-provider-setup.mjs',
  'src/bootstrap/runtime-supervisor-lock.mjs',
  'src/bootstrap/secure-bootstrap.mjs',
  'src/bootstrap/transactional-bootstrap.mjs',
];

const JSON_FILES = ['package.json', 'config/devbridge.example.json', 'config/devbridge.fast.json'];

const TARGETED_TESTS = [
  'test/config.test.js',
  'test/repository-execution.test.js',
  'test/repository-environment-execution.test.js',
  'test/app-repository-execution.test.js',
  'test/fast-host-repository-execution.test.js',
  'test/fast-codex-smoke.test.js',
  'test/runtime-execution.test.js',
  'test/file-tree-transfer.test.js',
  'test/workspace-agent.test.js',
  'test/bootstrap-candidate-execution.test.js',
  'test/elevated-provider-setup.test.js',
  'test/runtime-supervisor-lock.test.js',
  'test/environment-bootstrap-agent.test.js',
  'test/stage6-lego-boundary.test.js',
  'test/repository-execution-boundary-absence.test.js',
  'test/deterministic-execution-boundary.test.js',
  'test/work-runner.test.js',
  'test/work-runner-composition.test.js',
  'test/result-emission.test.js',
  'test/builtin-helper-entrypoints.test.js',
  'test/builtin-helper-resolver.test.js',
  'test/worker-exchange.test.js',
  'test/local-operation-manifest.test.js',
  'test/tool-onboarding.test.js',
  'test/external-directory.test.js',
  'test/project-relative-path.test.js',
  'test/doctor-capabilities.test.js',
  'test/chat-handoff.test.js',
  'test/chat-handoff-large.test.js',
  'test/chat-handoff-app.test.js',
  'test/chat-handoff-projection.test.js',
  'test/chat-handoff-mailbox.test.js',
  'test/context-budget.test.js',
  'test/controller-plan.test.js',
  'test/runtime-activation.test.js',
  'test/daemon-lock.test.js',
  'test/persistent-environments.test.js',
  'test/rate-budget.test.js',
];

function checked(runner, args, { cwd, label, timeoutMs }) {
  const result = runner(process.execPath, args, { cwd, stdio: 'pipe', shell: false, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
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
  return { syntaxFiles: SYNTAX_FILES.length, jsonFiles: JSON_FILES.length, targetedTests: targeted.length };
}

const thisFile = path.resolve(fileURLToPath(import.meta.url));
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryFile === thisFile) {
  try {
    const result = runRepositoryPreflight();
    process.stdout.write(`${JSON.stringify({ status: 'passed', ...result })}\n`);
  } catch (error) {
    process.stderr.write(`[devbridge-preflight] ${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
