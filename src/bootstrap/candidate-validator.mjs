import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createDeterministicSandboxProvider } from '../runtime/deterministic-sandbox.js';
import { containedSpawnOptions, terminateProcessTree } from '../runtime/process-tree.js';
import { runtimeArtifactSha256 } from './release-integrity.mjs';

const CAPTURE_LIMIT = 4 * 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 4 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

function fail(message) { throw new Error(message); }

function appendTail(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  if (combined.length <= maxBytes) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.length - maxBytes), truncated: true };
}

export function candidateValidationEnvironment(source = process.env, platform = process.platform) {
  const allowed = platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SystemDrive']
    : ['PATH'];
  const env = {};
  for (const name of allowed) if (source[name] != null) env[name] = String(source[name]);
  env.CI = '1';
  env.NO_COLOR = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.PATCH_POLLER_NONINTERACTIVE = '1';
  return env;
}

export function createRuntimeValidationSandbox(paths, { env = process.env } = {}) {
  const workspaceRoot = path.resolve(paths.runtimeCandidates ?? paths.home);
  // Deliberately use the bootstrap home as the sensitive control-state root.
  // The provider explicitly binds only the candidate project, so sibling config,
  // activation state, Git homes, credential stores, and current runtime remain
  // absent from the candidate namespace. Its verification probe also proves a
  // sentinel under this control root is unreadable from the sandbox.
  return createDeterministicSandboxProvider({
    externalReadRoots: [],
    workspaceRoot,
    stateDirectory: path.resolve(paths.home),
    env,
  });
}

async function capturePreparedExecution(prepared, {
  stdin = null,
  timeoutMs,
  maxOutputBytes = CAPTURE_LIMIT,
  spawnImpl = spawn,
} = {}) {
  const child = spawnImpl(
    prepared.executable,
    prepared.args,
    containedSpawnOptions({
      cwd: prepared.cwd,
      env: prepared.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  child.stdout?.on('data', (chunk) => {
    const next = appendTail(stdout, chunk, maxOutputBytes);
    stdout = next.buffer;
    truncated ||= next.truncated;
  });
  child.stderr?.on('data', (chunk) => {
    const next = appendTail(stderr, chunk, maxOutputBytes);
    stderr = next.buffer;
    truncated ||= next.truncated;
  });
  if (stdin == null) child.stdin?.end();
  else child.stdin?.end(stdin);

  let timedOut = false;
  let termination = null;
  const timer = setTimeout(() => {
    timedOut = true;
    termination = terminateProcessTree(child);
  }, timeoutMs);
  timer.unref?.();
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    if (termination) await termination;
  }
  return {
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    outputTruncated: truncated,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
  };
}

export async function runSandboxedCandidateCommand({
  paths,
  runtime,
  args,
  label,
  timeoutMs,
  sandboxProvider = null,
  env = process.env,
  spawnImpl = spawn,
}) {
  const projectDir = path.resolve(runtime.runtimeDir);
  const provider = sandboxProvider ?? createRuntimeValidationSandbox(paths, { env });
  const status = await provider.verify();
  if (status.verified !== true) {
    fail(`candidate ${label} requires a verified OS sandbox provider; ${status.reason ?? status.verification ?? 'sandbox unavailable'}`);
  }
  const prepared = await provider.prepareExecution({
    executable: process.execPath,
    args,
    cwd: projectDir,
    env: candidateValidationEnvironment(env),
    operation: `bootstrap-candidate:${label}`,
    sandbox: {
      required: true,
      projectDir,
      network: 'deny',
      exposeConfiguredReadRoots: false,
      trustedReadRoots: [],
    },
  });
  if (prepared?.evidence?.verified !== true) fail(`candidate ${label} did not receive verified sandbox evidence`);
  const outcome = await capturePreparedExecution(prepared, { timeoutMs, spawnImpl });
  if (outcome.timedOut || outcome.outputTruncated || outcome.exitCode !== 0) {
    const detail = String(outcome.stderr || outcome.stdout || '').trim();
    const reason = outcome.timedOut
      ? 'timed out'
      : outcome.outputTruncated
        ? 'exceeded bounded output'
        : `failed (exit ${outcome.exitCode ?? 'null'}, signal ${outcome.signal ?? 'none'})`;
    fail(`candidate ${label} ${reason}${detail ? `: ${detail.slice(-4000)}` : ''}`);
  }
  return { outcome, sandbox: prepared.evidence };
}

export async function validateRuntimeCandidate(paths, runtime, _legacyRunner = null, {
  expectedArtifactSha256 = null,
  sandboxProvider = null,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  const cwd = path.resolve(runtime.runtimeDir);
  const before = await runtimeArtifactSha256(cwd);
  if (expectedArtifactSha256 && before.sha256 !== expectedArtifactSha256) {
    fail(`candidate artifact changed before sandbox validation; expected ${expectedArtifactSha256}, observed ${before.sha256}`);
  }

  const provider = sandboxProvider ?? createRuntimeValidationSandbox(paths, { env });
  const verifiedProvider = await provider.verify();
  if (verifiedProvider.verified !== true) {
    fail(`candidate validation requires a verified OS sandbox provider; ${verifiedProvider.reason ?? verifiedProvider.verification ?? 'sandbox unavailable'}`);
  }

  const preflight = await runSandboxedCandidateCommand({
    paths,
    runtime,
    args: [path.join(cwd, 'src', 'bootstrap', 'repository-preflight.mjs')],
    label: 'cheap preflight',
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    sandboxProvider: provider,
    env,
    spawnImpl,
  });
  const tests = await runSandboxedCandidateCommand({
    paths,
    runtime,
    args: ['--test'],
    label: 'test suite',
    timeoutMs: TEST_TIMEOUT_MS,
    sandboxProvider: provider,
    env,
    spawnImpl,
  });

  const after = await runtimeArtifactSha256(cwd);
  if (after.sha256 !== before.sha256) {
    fail(`candidate validation mutated the exact runtime artifact; before=${before.sha256} after=${after.sha256}`);
  }
  return {
    preflight: 'passed-sandboxed',
    tests: 'passed-sandboxed',
    doctor: 'deferred-post-activation',
    artifactSha256: after.sha256,
    artifactFileCount: after.fileCount,
    artifactBytes: after.totalBytes,
    sandbox: {
      provider: tests.sandbox.provider ?? preflight.sandbox.provider ?? verifiedProvider.provider,
      verified: true,
      verification: tests.sandbox.verification ?? preflight.sandbox.verification ?? verifiedProvider.verification,
      filesystem: tests.sandbox.filesystem ?? preflight.sandbox.filesystem ?? verifiedProvider.filesystem,
      network: tests.sandbox.network ?? preflight.sandbox.network ?? verifiedProvider.network,
      gitAdministrativeState: tests.sandbox.gitAdministrativeState ?? preflight.sandbox.gitAdministrativeState ?? verifiedProvider.gitAdministrativeState,
    },
  };
}
