import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runRepositoryPreflight } from './repository-preflight.mjs';
import { createSandboxManager, EXECUTION_CLASS_REPOSITORY } from '../runtime/sandbox-manager.js';

const CAPTURE_LIMIT = 4 * 1024 * 1024;

function candidateEnvironment(source = process.env) {
  const allowed = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SystemDrive']
    : ['PATH'];
  const env = {};
  for (const name of allowed) if (source[name] != null) env[name] = source[name];
  env.CI = '1';
  env.NO_COLOR = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.PATCH_POLLER_NONINTERACTIVE = '1';
  return env;
}

function checkedCommand(executable, args, { cwd, env, runner, label, timeout }) {
  const result = runner(executable, args, {
    cwd,
    env,
    stdio: 'pipe',
    timeout,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: CAPTURE_LIMIT,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed (exit ${result.status ?? 'spawn-error'})${detail ? `: ${detail.slice(-4000)}` : ''}`);
  }
  return result;
}

function validationConfig(scratchRoot) {
  return {
    version: 1,
    github: {
      queueRepository: 'iteathen/PATCH-POLLER',
      taskLabel: 'patch-poller:ready',
      trustedActorIds: ['1'],
      auth: { mode: 'environment', environmentVariables: ['PATCH_POLLER_VALIDATION_NO_TOKEN'] },
      rateLimit: { reserveRatio: 0.2, minimumReserve: 250, emergencyReserve: 25, mutationIntervalMs: 1100 },
    },
    workspace: {
      root: path.join(scratchRoot, 'workspace'),
      allowCreate: true,
      allowedOwners: ['iteathen'],
      externalReadRoots: [],
    },
    state: { directory: path.join(scratchRoot, 'state') },
    execution: {
      enabled: false,
      controllerPlansEnabled: true,
      modelAdaptersEnabled: false,
      sandbox: { provider: 'none', executable: 'bwrap' },
      allowUncontainedTools: false,
      maxConcurrentTasks: 1,
      maxTurns: 2,
    },
    decisions: { enabled: true, expiryMs: 86_400_000, authorities: {} },
    git: { executable: 'git' },
    publication: { autoPushTaskBranches: false, forceNoOpPublication: false, branchPrefix: 'validation' },
    status: { progressIntervalMs: 300_000, maxCommentBytes: 48_000 },
    daemon: { errorBackoffMs: 60_000 },
    tools: {},
  };
}

async function sandboxedCommand(sandboxManager, executable, args, { projectDir, scratchRoot, runner, label, timeout }) {
  const launch = await sandboxManager.prepareLaunch({
    executionClass: EXECUTION_CLASS_REPOSITORY,
    executable,
    args,
    cwd: projectDir,
    env: candidateEnvironment(),
    projectDir,
    projectWrite: false,
    writableRoots: [scratchRoot],
  });
  return checkedCommand(launch.executable, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    runner,
    label,
    timeout,
  });
}

export async function validateCandidateRuntime({
  candidateDir,
  runner,
  environment = process.env,
  sandboxManager = null,
} = {}) {
  const cwd = path.resolve(candidateDir);
  const manager = sandboxManager ?? createSandboxManager({
    provider: environment.PATCH_POLLER_BOOTSTRAP_SANDBOX_PROVIDER ?? 'auto',
    executable: environment.PATCH_POLLER_BOOTSTRAP_SANDBOX_EXECUTABLE ?? 'bwrap',
  }, { env: environment });
  const verification = await manager.inspect({ refresh: true });
  if (verification.verified !== true) {
    throw new Error(`candidate execution requires a verified bootstrap sandbox (${verification.reason ?? 'unverified'})`);
  }

  // This function is imported from the currently trusted runtime. --check and
  // JSON.parse read candidate bytes but do not execute candidate JavaScript.
  const preflight = runRepositoryPreflight(cwd, runner, { staticOnly: true });

  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), 'patch-poller-candidate-validation-'));
  try {
    mkdirSync(path.join(scratchRoot, 'workspace'), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(scratchRoot, 'state'), { recursive: true, mode: 0o700 });
    const configFile = path.join(scratchRoot, 'config.json');
    writeFileSync(configFile, `${JSON.stringify(validationConfig(scratchRoot), null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    await sandboxedCommand(manager, process.execPath, ['--test'], {
      projectDir: cwd,
      scratchRoot,
      runner,
      label: 'sandboxed candidate test suite',
      timeout: 10 * 60_000,
    });

    const doctorScript = [
      "import { pathToFileURL } from 'node:url';",
      "import path from 'node:path';",
      "const root = process.cwd();",
      "const configFile = process.argv[1];",
      "const { loadConfig } = await import(pathToFileURL(path.join(root, 'src', 'config.js')).href);",
      "const { doctor } = await import(pathToFileURL(path.join(root, 'src', 'app', 'doctor.js')).href);",
      "const config = await loadConfig(configFile);",
      "const result = await doctor(config, { resolveTools: false, checkGit: false, checkGitHubAuth: false, probeCoreCapabilities: false, env: process.env });",
      "if (!result || result.ok !== true) { console.error('candidate doctor returned not-ready'); process.exitCode = 2; }",
    ].join('\n');
    await sandboxedCommand(manager, process.execPath, ['--input-type=module', '-e', doctorScript, configFile], {
      projectDir: cwd,
      scratchRoot,
      runner,
      label: 'sandboxed candidate doctor',
      timeout: 4 * 60_000,
    });

    return {
      preflight: 'passed',
      syntax: 'passed',
      tests: 'passed',
      doctor: 'passed',
      sandbox: {
        provider: verification.provider,
        verified: true,
        boundaries: verification.boundaries,
      },
      staticPreflight: preflight,
    };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}
