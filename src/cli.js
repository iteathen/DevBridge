#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.js';
import { doctor } from './app/doctor.js';
import { pollOnce } from './app/poll-once.js';
import { runOnce } from './app/run-once.js';
import { runDaemon } from './app/daemon.js';

function usage() { console.error('Usage: patch-poller <doctor|poll-once|run-once|daemon> --config <path>'); }
function configPath(argv) { const index = argv.indexOf('--config'); if (index < 0 || !argv[index + 1]) return null; return path.resolve(argv[index + 1]); }

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const file = configPath(args);
  if (!command || !file) { usage(); process.exitCode = 2; return; }
  const config = await loadConfig(file);
  if (command === 'doctor') { console.log(JSON.stringify(await doctor(config), null, 2)); return; }
  if (command === 'poll-once') {
    const result = await pollOnce(config);
    const safe = { ...result, tasks: result.tasks.map((task) => ({ queueRepository: task.queueRepository, issueNumber: task.issueNumber, revision: task.revision, targetRepository: task.envelope.target.repository, preferredTool: task.envelope.preferredTool, requestedCapabilities: task.envelope.requestedCapabilities, projectDir: task.projectDir })) };
    console.log(JSON.stringify(safe, null, 2)); return;
  }
  if (command === 'run-once') { console.log(JSON.stringify(await runOnce(config), null, 2)); return; }
  if (command === 'daemon') {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await runDaemon(config, { signal: controller.signal, onEvent: (event) => console.log(JSON.stringify(event)) });
    return;
  }
  usage(); process.exitCode = 2;
}

main().catch((error) => { console.error(`${error.name}: ${error.message}`); if (error.retryAt) console.error(`retryAt=${new Date(error.retryAt).toISOString()}`); process.exitCode = 1; });
