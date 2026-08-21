import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const SYNTAX_FILES = [
  'devbridge.mjs',
  'src/cli.js',
  'src/config.js',
  'src/app/runtime.js',
  'src/app/runtime-execution.js',
  'src/app/repository-execution.js',
  'src/app/doctor.js',
  'src/app/chat-handoff.js',
  'src/context/chat-handoff.js',
  'src/context/context-budget.js',
  'src/github/chat-handoff-projector.js',
  'src/run/controller-plan.js',
  'src/run/run-coordinator.js',
  'src/runtime/repository-execution.js',
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
  'src/bootstrap/compatibility-activation.mjs',
  'src/bootstrap/local-supervisor-adapter.mjs',
  'src/bootstrap/runtime-transition.mjs',
  'src/bootstrap/secure-bootstrap.mjs',
  'src/bootstrap/transactional-bootstrap.mjs',
];

const JSON_FILES = ['package.json', 'config/devbridge.example.json'];

const TARGETED_TESTS = [
  'test/config.test.js',
  'test/repository-execution.test.js',
  'test/repository-environment-execution.test.js',
  'test/app-repository-execution.test.js',
  'test/runtime-execution.test.js',
  'test/file-tree-transfer.test.js',
  'test/workspace-agent.test.js',
  'test/bootstrap-candidate-execution.test.js',
  'test/bootstrap-compatibility-activation.test.js',
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
  'test/secure-supervisor-release.test.js',
  'test/local-supervisor-adapter.test.js',
  'test/runtime-transition.test.js',
  'test/rate-budget.test.js',
];

function checked(runner, args, { cwd, label, timeoutMs }) {
  const result = runner(process.execPath, args, { cwd, stdio: 'pipe', shell: false, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed (exit ${result.status ?? 'spawn-error'})${detail ? `: ${detail.slice(-4000)}` : ''}`);
  }
}

function protocolNumber(value, name) {
  if (value == null || value === '') return 0;
  if (!/^\d+$/u.test(String(value))) throw new Error(`${name} is invalid`);
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

export function assertCandidateStage0Compatibility(root = process.cwd(), environment = process.env) {
  const candidateValidation = environment.CI === '1' && environment.DEVBRIDGE_NONINTERACTIVE === '1';
  if (!candidateValidation) return Object.freeze({ checked: false, activeStage0Protocol: null, requiredStage0Protocol: null });

  const packagePath = path.join(path.resolve(root), 'package.json');
  let manifest;
  try { manifest = JSON.parse(readFileSync(packagePath, 'utf8')); }
  catch (error) { throw new Error(`candidate package compatibility metadata is unavailable: ${error.message}`, { cause: error }); }
  const required = protocolNumber(manifest?.devbridge?.bootstrap?.minimumStage0Protocol ?? 0, 'candidate minimum Stage 0 protocol');
  const active = protocolNumber(environment.DEVBRIDGE_STAGE0_PROTOCOL, 'active Stage 0 protocol');
  if (required > active) {
    throw new Error(`candidate requires Stage 0 protocol ${required}, but the validating launcher provides ${active}; refresh Stage 0 before candidate activation`);
  }
  return Object.freeze({ checked: true, activeStage0Protocol: active, requiredStage0Protocol: required });
}

export function runRepositoryPreflight(root = process.cwd(), runner = spawnSync, environment = process.env) {
  const cwd = path.resolve(root);
  const compatibility = assertCandidateStage0Compatibility(cwd, environment);
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
  return { syntaxFiles: SYNTAX_FILES.length, jsonFiles: JSON_FILES.length, targetedTests: targeted.length, compatibility };
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
