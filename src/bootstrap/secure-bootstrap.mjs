import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as transactional from './transactional-bootstrap.mjs';
import { validateCandidateRuntime } from './candidate-validator.mjs';
import { loadBootstrapReleasePolicy, verifyRuntimeRelease } from './release-integrity.mjs';

export * from './transactional-bootstrap.mjs';

const CAPTURE_LIMIT = 4 * 1024 * 1024;
const ACTIVATION_PROTOCOL = 'patch-poller/runtime-activation-v1';

function defaultRunner(executable, args, options) {
  return spawnSync(executable, args, {
    ...options,
    shell: false,
    encoding: options.stdio === 'inherit' ? undefined : 'utf8',
    maxBuffer: CAPTURE_LIMIT,
  });
}

function candidateTreeSha(paths, runtimeDir, runner) {
  const result = transactional.runGit(['rev-parse', 'HEAD^{tree}'], { paths, cwd: runtimeDir, runner });
  const tree = String(result.stdout ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(tree)) throw new Error('candidate tree identity is invalid');
  return tree;
}

async function establishRuntimeTrust(args, paths, runtime, {
  runner = defaultRunner,
  validateCandidateFn = validateCandidateRuntime,
  loadPolicyFn = loadBootstrapReleasePolicy,
  verifyReleaseFn = verifyRuntimeRelease,
  environment = process.env,
  sandboxManager = null,
} = {}) {
  const runtimeDir = path.resolve(runtime.runtimeDir);
  const head = String(runtime.head).toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error('runtime trust establishment requires an exact commit SHA');
  const tree = candidateTreeSha({ ...paths, runtime: runtimeDir }, runtimeDir, runner);
  const policy = loadPolicyFn({ channel: args.channel, paths, environment });
  const releaseIntegrity = verifyReleaseFn({ candidateDir: runtimeDir, commitSha: head, treeSha: tree, policy });
  const validation = await validateCandidateFn({ candidateDir: runtimeDir, runner, environment, sandboxManager });
  return { ...runtime, head, runtimeDir, tree, releaseIntegrity, validation };
}

function healthyBaselineRecord(runtime) {
  const current = {
    ref: runtime.ref,
    head: runtime.head,
    version: runtime.version,
    runtimeDir: path.resolve(runtime.runtimeDir),
    cliPath: path.resolve(runtime.cliPath),
  };
  return {
    protocol: ACTIVATION_PROTOCOL,
    state: 'healthy',
    previous: null,
    candidate: null,
    current,
    failedCandidate: null,
    error: null,
    integrity: runtime.releaseIntegrity ?? null,
    validation: runtime.validation?.sandbox ? { sandbox: runtime.validation.sandbox } : null,
    updatedAt: new Date().toISOString(),
  };
}

export async function prepareRuntimeCandidate(args, paths, {
  desiredRef,
  desiredHead,
  runner = defaultRunner,
  ensureRuntimeFn = transactional.ensureRuntime,
  validateCandidateFn = validateCandidateRuntime,
  loadPolicyFn = loadBootstrapReleasePolicy,
  verifyReleaseFn = verifyRuntimeRelease,
  environment = process.env,
  sandboxManager = null,
} = {}) {
  if (!desiredRef || !/^[0-9a-f]{40}$/iu.test(String(desiredHead))) throw new Error('candidate preparation requires a trusted ref and exact head');
  const runtimeDir = transactional.candidateRuntimePath(paths, desiredHead);
  const candidatePaths = { ...paths, runtime: runtimeDir };
  const candidate = ensureRuntimeFn({ ...args, update: true }, candidatePaths, runner);
  if (candidate.ref !== desiredRef || candidate.head.toLowerCase() !== String(desiredHead).toLowerCase()) {
    throw new Error(`candidate changed during preparation; expected ${desiredRef}@${desiredHead}, observed ${candidate.ref}@${candidate.head}`);
  }
  return establishRuntimeTrust(args, paths, { ...candidate, runtimeDir }, {
    runner,
    validateCandidateFn,
    loadPolicyFn,
    verifyReleaseFn,
    environment,
    sandboxManager,
  });
}

export async function bootstrap(argv = process.argv.slice(2), runner = defaultRunner) {
  transactional.assertSupportedNode();
  const args = transactional.parseBootstrapArgs(argv);
  const paths = transactional.resolveBootstrapPaths(args);
  const runtimeExists = existsSync(paths.runtime);

  let runtime = transactional.loadPersistedHealthyRuntime(paths, runner);
  if (!runtime) {
    runtime = transactional.ensureRuntime(runtimeExists ? { ...args, update: false } : args, paths, runner);
    runtime = await establishRuntimeTrust(args, paths, { ...runtime, runtimeDir: paths.runtime }, { runner });
    transactional.writeRuntimeActivationState(paths, healthyBaselineRecord(runtime));
  }

  process.stdout.write(`[patch-poller-bootstrap] channel=${args.channel} ref=${runtime.ref} version=${runtime.version} head=${runtime.head}\n`);
  if (transactional.prepareLocalConfig(paths, runtime)) {
    process.stdout.write(
      `[patch-poller-bootstrap] Created safe local config: ${paths.config}\n` +
      '[patch-poller-bootstrap] Review execution/controller-plan policy and enable execution only when ready.\n' +
      '[patch-poller-bootstrap] Then run this same command again.\n',
    );
    return 0;
  }

  if (args.command === 'status' || args.command === 'stop') {
    return transactional.runPollerCli(args.command, paths, runtime, runner);
  }

  const doctorStatus = transactional.runPollerCli('doctor', paths, runtime, runner);
  if (doctorStatus !== 0 || args.command === 'doctor') return doctorStatus;
  if (args.command !== 'daemon' && args.command !== 'restart') {
    return transactional.runPollerCli(args.command, paths, runtime, runner);
  }

  await transactional.stopExistingDaemon(paths, runtime, runner);
  const controller = new AbortController();
  const requestStop = () => controller.abort();
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    return await transactional.superviseDaemon(
      { ...args, command: 'daemon' },
      paths,
      runtime,
      {
        runner,
        takeover: false,
        signal: controller.signal,
        candidatePrepareFn: (candidateArgs, candidatePaths, options) => prepareRuntimeCandidate(candidateArgs, candidatePaths, options),
      },
    );
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}
