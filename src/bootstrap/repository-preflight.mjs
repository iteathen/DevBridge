import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const SYNTAX_FILES = [
  'devbridge.mjs',
  'install-devbridge.mjs',
  'bootstrap-devbridge.mjs',
  'scripts/build-standalone-artifacts.mjs',
  'src/bootstrap/standalone-artifact.mjs',
  'src/install/permanent-entry-installer.mjs',
  'src/install/permanent-entry-installer/input-contract.mjs',
  'src/install/permanent-entry-installer/source-channel.mjs',
  'src/install/permanent-entry-installer/component-store.mjs',
  'src/install/permanent-entry-installer/mutation-lease.mjs',
  'src/install/permanent-entry-installer/entry-publication.mjs',
  'src/install/permanent-entry-installer/continuation.mjs',
  'src/bootstrap/zero-state-bootstrap.mjs',
  'src/bootstrap/zero-state-bootstrap/input-contract.mjs',
  'src/bootstrap/zero-state-bootstrap/selection-state.mjs',
  'src/bootstrap/zero-state-bootstrap/source-channel.mjs',
  'src/bootstrap/zero-state-bootstrap/temporary-materialization.mjs',
  'src/cli.js',
  'src/config.js',
  'src/app/runtime.js',
  'src/app/runtime-execution.js',
  'src/git/workspace-manager.js',
  'src/git/workspace-manager/baseline-authority.js',
  'src/git/workspace-manager/baseline-reconciliation.js',
  'src/git/workspace-manager/candidate-sealing.js',
  'src/git/workspace-manager/publication-transaction.js',
  'src/git/workspace-manager/repository-admission.js',
  'src/git/workspace-manager/workspace-observation.js',
  'src/git/workspace-manager/worktree-lifecycle.js',
  'src/app/repository-execution.js',
  'src/app/repository-execution/byte-channel.js',
  'src/app/repository-execution/operation-materializer.js',
  'src/app/repository-execution/route-access.js',
  'src/app/repository-execution/session-guard.js',
  'src/app/repository-execution/workspace-session.js',
  'src/app/doctor.js',
  'src/app/chat-handoff.js',
  'src/context/chat-handoff.js',
  'src/context/context-budget.js',
  'src/github/chat-handoff-projector.js',
  'src/run/controller-plan.js',
  'src/run/controller-plan-executor.js',
  'src/run/deterministic-c-acceptance.js',
  'src/run/run-coordinator.js',
  'src/run/run-coordinator/candidate-recovery.js',
  'src/run/run-coordinator/feedback-continuation.js',
  'src/run/run-coordinator/finalization-policy.js',
  'src/run/run-coordinator/projections.js',
  'src/run/run-coordinator/retry-window.js',
  'src/runtime/repository-execution.js',
  'src/runtime/repository-environment-execution.js',
  'src/runtime/file-tree-transfer.js',
  'src/guest/activity-store.mjs',
  'src/guest/local-process.mjs',
  'src/guest/transfer-channel.mjs',
  'src/guest/workspace-agent.mjs',
  'src/guest/image-payload.js',
  'src/guest/environment-bootstrap-agent.mjs',
  'src/runtime/result-json.js',
  'src/runtime/result-emission.js',
  'src/runtime/bounded-text-read.js',
  'src/runtime/local-filesystem-identity.js',
  'src/runtime/work-runner.js',
  'src/app/work-runner-composition.js',
  'src/app/builtin-helper-resolver.js',
  'src/runtime/native-compiler-probe-cli.js',
  'src/runtime/chat-c-project-probe-cli.js',
  'src/runtime/lifecycle-roundtrip-probe-cli.js',
  'src/runtime/transient-recovery-probe-cli.js',
  'src/values/boot-protection.js',
  'src/app/environment-materialization-policy.js',
  'src/app/environment-activity-host.js',
  'src/app/linux-environment-activity-state.js',
  'src/runtime/environment-activity-policy-state.js',
  'src/app/environment-lifecycle-authority-host.js',
  'src/app/protected-environment-configuration.js',
  'src/app/linux-environment-configuration-host.js',
  'src/app/environment-operator.js',
  'src/app/setup.js',
  'src/app/setup-image-distribution-policy.js',
  'src/app/setup-profile-selection.js',
  'src/app/setup-windows-activation-policy.js',
  'src/app/setup-environment-profile-configuration.js',
  'src/app/windows-install-media-setup.js',
  'src/app/windows-production-image-setup.js',
  'src/app/windows-environment-configuration-host.js',
  'src/app/windows-lifecycle-authority-setup-child.js',
  'src/runtime/environment-declaration.js',
  'src/runtime/environment-configuration-authority.js',
  'src/runtime/environment-configuration-authority-transport.js',
  'src/runtime/environment-profile-configuration.js',
  'src/runtime/environment-foundation.js',
  'src/runtime/persistent-environments.js',
  'src/runtime/persistent-environments/effect-channel.js',
  'src/runtime/persistent-environments/generation-change.js',
  'src/runtime/persistent-environments/ledger.js',
  'src/runtime/persistent-environments/ordinary-lifecycle.js',
  'src/runtime/persistent-environments/provisioning.js',
  'src/runtime/persistent-environments/retirement.js',
  'src/runtime/providers/hyperv-environment-identity.js',
  'src/state/environment-profile-configuration-state-store.js',
  'src/state/setup-resource-conflict-consent-store.js',
  'src/state/immutable-subject-record-state-store.js',
  'src/setup/ubuntu-authority.js',
  'src/setup/resource-conflict.js',
  'src/setup/operational-configuration.js',
  'src/setup/status-observer.js',
  'src/setup/status-operation.js',
  'src/setup/profile-selection.js',
  'src/setup/environment-profile-source.js',
  'src/setup/environment-profile-configuration-record.js',
  'src/setup/environment-profile-configuration-proxy.js',
  'src/setup/serial-reconciliation.js',
  'src/setup/serial-profile-action.js',
  'src/setup/ubuntu-environment-profile-source.js',
  'src/setup/linux-environment-profile-configuration.js',
  'src/setup/linux-environment-configuration-handoff.js',
  'src/setup/linux-environment-activity-handoff.js',
  'src/setup/linux-environment-activity-projection.js',
  'src/setup/linux-local-socket-preparation.js',
  'src/setup/windows-environment-profile-configuration.js',
  'src/setup/windows-environment-profile-source.js',
  'src/setup/windows-production-output.js',
  'src/setup/image-distribution-policy.js',
  'src/setup/windows-resource-conflict.js',
  'src/setup/image-library-adoption.js',
  'src/setup/windows-lifecycle-authority-image-adoption.js',
  'src/setup/windows-lifecycle-authority-migration-safety.js',
  'src/setup/windows-lifecycle-authority-readiness.js',
  'src/setup/windows-lifecycle-authority-service.js',
  'src/runtime/providers/hyperv-persistent-environment-core.js',
  'src/runtime/providers/hyperv-persistent-environment/environment-contract.js',
  'src/runtime/providers/hyperv-persistent-environment/management-channel.js',
  'src/runtime/providers/hyperv-persistent-environment/state-ledger.js',
  'src/runtime/providers/hyperv-persistent-environment/storage-lineage.js',
  'src/runtime/providers/libvirt-persistent-environment-core.js',
  'src/runtime/providers/libvirt-persistent-environment/domain-channel.js',
  'src/runtime/providers/libvirt-persistent-environment/environment-contract.js',
  'src/runtime/providers/libvirt-persistent-environment/overlay-lineage.js',
  'src/runtime/providers/libvirt-persistent-environment/state-ledger.js',
  'src/runtime/providers/hyperv-image-construction.js',
  'src/runtime/providers/hyperv-image-construction/console-evidence.js',
  'src/runtime/providers/hyperv-image-construction/install-liveness.js',
  'src/runtime/providers/hyperv-image-construction/management-channel.js',
  'src/runtime/providers/hyperv-image-construction/media-admission.js',
  'src/runtime/providers/hyperv-image-construction/observation.js',
  'src/runtime/providers/hyperv-image-construction/request-contract.js',
  'src/runtime/providers/hyperv-image-construction/state-ledger.js',
  'src/runtime/image-builders/windows-install-media-authority.js',
  'src/runtime/image-builders/windows-install-media-authority-catalog.js',
  'src/runtime/image-builders/production-image-canary-composition.js',
  'src/runtime/image-builders/windows-production-image-authority.js',
  'src/runtime/image-builders/windows-production-image-authority-catalog.js',
  'src/runtime/image-builders/windows-unattended-seed.js',
  'src/runtime/image-builders/windows-unattended-media.js',
  'src/runtime/image-builders/windows-production-operations.js',
  'src/runtime/image-builders/windows-production-qualification.js',
  'src/runtime/image-sources/windows-install-media-inspector.js',
  'src/runtime/image-sources/windows-install-media-source.js',
  'src/runtime/providers/hyperv-guest-operation.js',
  'src/runtime/providers/windows-protected-access-material.js',
  'src/runtime/providers/windows-protected-image-construction-preflight.js',
  'src/runtime/providers/windows-imapi-data-media.js',
  'src/runtime/providers/windows-imapi-nocloud-seed.js',
  'src/guest/windows-access-seed-agent.mjs',
  'src/guest/windows-image-payload.js',
  'src/setup/windows-toolchain-authority.js',
  'src/setup/windows-activation-policy.js',
  'src/setup/windows-install-media-selection.js',
  'src/state/windows-install-media-authority-state-store.js',
  'src/state/windows-install-media-selection-state-store.js',
  'src/state/windows-install-media-source-state-store.js',
  'src/state/windows-production-qualification-state-store.js',
  'src/state/windows-production-image-authority-state-store.js',
  'src/app/windows-production-image-physical-canary.js',
  'src/entry/windows-production-image-canary-entry.mjs',
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
  'src/setup/linux-directory-definition-applicator.js',
  'src/setup/linux-lifecycle-authority-generation.js',
  'src/setup/linux-lifecycle-authority-inspection.js',
  'src/setup/linux-lifecycle-authority-refresh-composition.js',
  'src/setup/linux-lifecycle-authority-refresh-mechanics.js',
  'src/setup/linux-lifecycle-authority-endpoint-topology.js',
  'src/setup/linux-protected-tree.js',
];

const JSON_FILES = ['package.json', 'config/devbridge.example.json'];
const MAX_FAILURE_EVIDENCE_CHARS = 4000;

const TARGETED_TESTS = [
  'test/standalone-artifact.test.js',
  'test/installer-stage0-nested-lego.test.js',
  'test/self-install-entry.test.js',
  'test/zero-state-bootstrap.test.js',
  'test/zero-state-exact-source.test.js',
  'test/zero-state-installer-handoff.test.js',
  'test/config.test.js',
  'test/setup-authority-nested-lego.test.js',
  'test/setup-authority-state-store-lego.test.js',
  'test/setup-authority-state-serialization.test.js',
  'test/provider-local-nested-lego.test.js',
  'test/workspace-manager-nested-lego.test.js',
  'test/repository-execution.test.js',
  'test/repository-environment-execution.test.js',
  'test/app-repository-execution.test.js',
  'test/repository-execution-nested-lego.test.js',
  'test/runtime-execution.test.js',
  'test/file-tree-transfer.test.js',
  'test/workspace-agent.test.js',
  'test/bootstrap-candidate-execution.test.js',
  'test/bootstrap-compatibility-activation.test.js',
  'test/environment-bootstrap-agent.test.js',
  'test/activity-store.test.js',
  'test/local-process.test.js',
  'test/transfer-channel.test.js',
  'test/guest-image-payload.test.js',
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
  'test/doctor-environment-operator.test.js',
  'test/environment-lifecycle-authority.test.js',
  'test/environment-lifecycle-authority-transport.test.js',
  'test/environment-lifecycle-authority-host.test.js',
  'test/environment-configuration-authority.test.js',
  'test/environment-configuration-authority-transport.test.js',
  'test/environment-configuration-lego.test.js',
  'test/local-filesystem-identity.test.js',
  'test/chat-handoff.test.js',
  'test/chat-handoff-nested-lego.test.js',
  'test/chat-handoff-large.test.js',
  'test/chat-handoff-app.test.js',
  'test/chat-handoff-projection.test.js',
  'test/chat-handoff-mailbox.test.js',
  'test/context-budget.test.js',
  'test/controller-plan.test.js',
  'test/controller-recovery.test.js',
  'test/deterministic-c-acceptance.test.js',
  'test/run-coordinator-nested-lego.test.js',
  'test/runtime-activation.test.js',
  'test/secure-supervisor-release.test.js',
  'test/local-supervisor-adapter.test.js',
  'test/runtime-transition.test.js',
  'test/rate-budget.test.js',
  'test/repository-preflight-diagnostics.test.js',
  'test/linux-protected-transfer.test.js',
  'test/linux-environment-configuration-handoff.test.js',
  'test/linux-environment-configuration-host.test.js',
  'test/linux-environment-profile-configuration.test.js',
  'test/environment-activity-policy-state.test.js',
  'test/linux-environment-activity-handoff.test.js',
  'test/linux-environment-activity-state.test.js',
  'test/linux-environment-activity-projection.test.js',
  'test/linux-local-socket-preparation.test.js',
  'test/linux-protected-tree.test.js',
  'test/linux-lifecycle-authority-generation.test.js',
  'test/linux-lifecycle-authority-inspection.test.js',
  'test/linux-lifecycle-authority-refresh-composition.test.js',
  'test/linux-lifecycle-authority-refresh-mechanics.test.js',
  'test/linux-lifecycle-authority-identity-binding.test.js',
  'test/definition-reconciliation.test.js',
  'test/linux-service-manager.test.js',
  'test/linux-service-observation.test.js',
  'test/linux-service-definition.test.js',
  'test/linux-directory-definition-applicator.test.js',
  'test/linux-lifecycle-authority-endpoint-topology.test.js',
  'test/windows-install-media-authority.test.js',
  'test/windows-install-media-authority-state-store.test.js',
  'test/windows-install-media-inspector.test.js',
  'test/windows-install-media-lego.test.js',
  'test/windows-install-media-selection.test.js',
  'test/windows-install-media-setup.test.js',
  'test/windows-install-media-source.test.js',
  'test/windows-production-image-setup.test.js',
  'test/environment-construction-ports.test.js',
  'test/environment-activity-host.test.js',
  'test/environment-operator.test.js',
  'test/environment-profile-configuration.test.js',
  'test/environment-profile-configuration-lego.test.js',
  'test/resource-conflict-lego.test.js',
  'test/resource-conflict.test.js',
  'test/setup-environment-profile-configuration.test.js',
  'test/setup-image-distribution-policy.test.js',
  'test/setup-image-distribution-policy-lego.test.js',
  'test/setup.test.js',
  'test/setup-construction.test.js',
  'test/setup-operational-configuration.test.js',
  'test/setup-prerequisite-binding.test.js',
  'test/setup-profile-selection.test.js',
  'test/setup-windows-activation-policy.test.js',
  'test/bounded-text-read.test.js',
  'test/bounded-text-read-lego.test.js',
  'test/environment-profile-source.test.js',
  'test/serial-reconciliation.test.js',
  'test/serial-profile-action.test.js',
  'test/setup-status-observer.test.js',
  'test/setup-status-operation.test.js',
  'test/windows-environment-profile-configuration.test.js',
  'test/windows-environment-configuration-host.test.js',
  'test/windows-environment-profile-source.test.js',
  'test/image-distribution-policy.test.js',
  'test/image-distribution-policy-lego.test.js',
  'test/windows-activation-policy.test.js',
  'test/windows-activation-policy-lego.test.js',
  'test/immutable-subject-record-state-store.test.js',
  'test/windows-resource-conflict.test.js',
  'test/windows-lifecycle-authority-one-command.test.js',
  'test/environment-foundation.test.js',
  'test/image-library-adoption.test.js',
  'test/windows-lifecycle-authority-image-adoption.test.js',
  'test/windows-lifecycle-authority-migration-safety.test.js',
  'test/windows-lifecycle-authority-readiness.test.js',
  'test/windows-lifecycle-authority-service.test.js',
  'test/hyperv-persistent-environment.test.js',
  'test/libvirt-persistent-environment.test.js',
  'test/persistent-environment-effect-channel.test.js',
  'test/persistent-environment-ledger.test.js',
  'test/persistent-environments.test.js',
  'test/persistent-environments-replacement.test.js',
  'test/persistent-environments-recreate.test.js',
  'test/persistent-environments-rebuild.test.js',
  'test/stage3-lego-boundary.test.js',
  'test/hyperv-image-construction.test.js',
  'test/windows-imapi-data-media.test.js',
  'test/windows-imapi-nocloud-seed.test.js',
  'test/windows-unattended-seed.test.js',
  'test/windows-unattended-media.test.js',
  'test/hyperv-guest-operation.test.js',
  'test/windows-access-seed-agent.test.js',
  'test/windows-guest-image-payload.test.js',
  'test/windows-toolchain-authority.test.js',
  'test/windows-production-operations.test.js',
  'test/windows-production-qualification.test.js',
  'test/windows-production-qualification-state-store.test.js',
  'test/windows-protected-access-material.test.js',
  'test/windows-production-image-authority.test.js',
  'test/windows-production-image-authority-catalog.test.js',
  'test/windows-protected-image-construction-preflight.test.js',
  'test/windows-production-image-physical-canary.test.js',
  'test/windows-production-image-canary-entry.test.js',
];

function cleanOutput(value) {
  return String(value ?? '').replaceAll('\r\n', '\n').trim();
}

function labeledOutput(result) {
  const values = [
    ['process-error', result.error?.stack || result.error?.message],
    ['stderr', result.stderr],
    ['stdout', result.stdout],
  ].map(([name, value]) => [name, cleanOutput(value)]).filter(([, value]) => value.length > 0);
  return values.map(([name, value]) => `[${name}]\n${value}`).join('\n');
}

function firstFailureHint(value) {
  const patterns = [
    /^not ok\s+\d+\s+-\s+/mu,
    /^[✖✗×]\s+/mu,
    /^(?:AssertionError|Error):\s+/mu,
    /^\s*(?:code|failureType):\s*['"]?(?:ERR_|testCodeFailure)/mu,
  ];
  const indices = patterns.map((pattern) => pattern.exec(value)?.index).filter(Number.isSafeInteger);
  return indices.length === 0 ? null : Math.min(...indices);
}

function lineStart(value, index) {
  const selected = value.lastIndexOf('\n', Math.max(0, index - 1));
  return selected < 0 ? 0 : selected + 1;
}

function clipped(value, maximum) {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum).trimEnd();
}

export function boundedProcessFailureEvidence(result, maximumChars = MAX_FAILURE_EVIDENCE_CHARS) {
  if (!Number.isSafeInteger(maximumChars) || maximumChars < 256 || maximumChars > 64 * 1024) {
    throw new TypeError('process failure evidence bound is invalid');
  }
  const value = labeledOutput(result);
  if (value.length <= maximumChars) return value;
  const separator = '\n...[bounded output omitted]...\n';
  const tailBudget = Math.min(1200, Math.floor(maximumChars / 3));
  const focusBudget = maximumChars - tailBudget - separator.length;
  const hint = firstFailureHint(value);
  let focus;
  if (hint == null) {
    focus = value.slice(0, focusBudget);
  } else {
    const markerStart = lineStart(value, hint);
    const start = Math.max(0, markerStart - Math.min(256, Math.floor(focusBudget / 5)));
    focus = value.slice(start, start + focusBudget);
  }
  const projected = `${focus.trimEnd()}${separator}${value.slice(-tailBudget).trimStart()}`;
  return clipped(projected, maximumChars);
}

function checked(runner, args, { cwd, label, timeoutMs }) {
  const result = runner(process.execPath, args, { cwd, stdio: 'pipe', shell: false, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = boundedProcessFailureEvidence(result);
    throw new Error(`${label} failed (exit ${result.status ?? 'spawn-error'})${detail ? `: ${detail}` : ''}`);
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
  checked(runner, ['scripts/build-standalone-artifacts.mjs', '--check'], {
    cwd,
    label: 'standalone artifact regeneration check',
    timeoutMs: 60_000,
  });
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
  return { standaloneArtifacts: 2, syntaxFiles: SYNTAX_FILES.length, jsonFiles: JSON_FILES.length, targetedTests: targeted.length, compatibility };
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
