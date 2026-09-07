import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

function fail(message) { throw new Error(message); }

function defaultRunner(executable, args, options) {
  return spawnSync(executable, args, { ...options, shell: false, windowsHide: false });
}

export function createContinuation() {
  function run({ launcher, arguments: args, workingDirectory }, {
    runner = defaultRunner,
    environment = process.env,
  } = {}) {
    if (typeof launcher !== 'string' || !path.isAbsolute(launcher) ||
        typeof workingDirectory !== 'string' || !path.isAbsolute(workingDirectory) ||
        !Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
      throw new TypeError('continuation requires one exact launcher, working directory, and argument list');
    }
    const result = runner(process.execPath, [launcher, ...args], {
      cwd: workingDirectory,
      env: environment,
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
    });
    if (result?.error) fail(`Could not enter continuation: ${result.error.message}`);
    if (!Number.isInteger(result?.status)) fail('Continuation exited without a bounded status code');
    return result.status;
  }

  return Object.freeze({ run });
}
