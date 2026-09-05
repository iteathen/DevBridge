import process from 'node:process';
import { runWithLocalLiveness } from './local-liveness.js';
import { runUbuntuProductionImageRetentionCommand } from './ubuntu-production-image-retention-command.js';

export async function runConstructionRetentionCli(argv, {
  resultOutput = process.stdout,
  statusOutput = process.stderr,
  execute = runUbuntuProductionImageRetentionCommand,
  observe = runWithLocalLiveness,
} = {}) {
  if (!resultOutput || typeof resultOutput.write !== 'function' || !statusOutput || typeof statusOutput.write !== 'function'
      || typeof execute !== 'function' || typeof observe !== 'function') throw new TypeError('construction retention CLI composition is incomplete');
  const result = await observe(
    (onProgress) => execute(argv, { onProgress }),
    { output: statusOutput },
  );
  resultOutput.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
