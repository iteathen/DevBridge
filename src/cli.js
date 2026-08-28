#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { trackInstalledRunnerRef } from '../install-devbridge.mjs';
import { loadConfig } from './config.js';
import { doctor } from './app/doctor.js';
import { pollOnce } from './app/poll-once.js';
import { runOnce } from './app/run-once.js';
import { runDaemon } from './app/daemon.js';
import { createLinuxActivityAdmission } from './app/linux-activity-admission.js';
import { createRuntime } from './app/runtime.js';
import { selectConfiguredQueue } from './app/queue-selection.js';
import { createConfiguredLifecycleAuthorityClient } from './runtime/environment-lifecycle-authority-transport.js';
import { chatHandoffSeed, chatHandoffStatus } from './app/chat-handoff.js';
import { formatSetupHandoff, runDevBridgeSetup } from './app/setup.js';
import { runWindowsLifecycleAuthoritySetupChild } from './app/windows-lifecycle-authority-setup-child.js';
import { PolicyError } from './errors.js';
import { parseSetupCommandOptions } from './setup/command-options.js';
import { logicalEnvironmentIdentity } from './runtime/environment-declaration.js';
import { daemonStatus, pauseDaemon, resumeDaemon, stopDaemon } from './runtime/daemon-lock.js';

const installationTag = process.env.DEVBRIDGE_INSTALLATION_TAG;
if (/^DB-[0-9A-F]{12}$/u.test(installationTag ?? '')) process.title = `DevBridge[${installationTag}]`;

function usage() {
  console.error('Usage: devbridge setup [--construct] [--track-ref <branch>] [--retire-conflict <subject>] [--home <path>] [--repository owner/name|all]...');
  console.error('       devbridge <doctor|poll-once|run-once|daemon|status|pause|resume|stop|restart|handoff-status|handoff-seed|handoff-project|environment> --config <path> [options]');
  console.error('       devbridge environment <list|show|plan|create|repair|rebuild|reset|recreate|resume|setup-reentry> --config <path> [--identity id|--profile name] [--operation op] [--confirm subject]');
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) return null;
  return argv[index + 1];
}

function configPath(argv) {
  const value = optionValue(argv, '--config');
  return value ? path.resolve(value) : null;
}

function integerOption(argv, name) {
  const value = optionValue(argv, name);
  if (value == null) return null;
  if (!/^\d+$/u.test(value)) throw new PolicyError(`${name} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PolicyError(`${name} must be a positive safe integer`);
  return parsed;
}

function daemonLockPath(config) {
  return path.join(config.state.directory, 'daemon.lock');
}

function environmentIdentity(args) {
  const explicit = optionValue(args, '--identity');
  const profile = optionValue(args, '--profile');
  if (explicit && profile) throw new PolicyError('use either --identity or --profile, not both');
  return explicit ?? (profile ? logicalEnvironmentIdentity(profile) : null);
}

async function runEnvironmentCommand(config, args) {
  const [action] = args;
  if (!action) throw new PolicyError('environment command requires an action');
  const operator = createConfiguredLifecycleAuthorityClient({ stateDirectory: config.state.directory });
  const identity = environmentIdentity(args);
  if (action === 'list') return operator.list();
  if (action === 'setup-reentry') return operator.setupReentry(identity);
  if (!identity) throw new PolicyError(`environment ${action} requires --identity or --profile`);
  if (action === 'show') return operator.status(identity);
  if (action === 'resume') return operator.resume(identity, { approval: optionValue(args, '--confirm') });
  if (action === 'plan') {
    const operation = optionValue(args, '--operation');
    if (!operation) throw new PolicyError('environment plan requires --operation');
    return operator.plan(operation, identity);
  }
  if (['create', 'repair', 'rebuild', 'reset', 'recreate'].includes(action)) {
    return operator.run(action, identity, { approval: optionValue(args, '--confirm') });
  }
  throw new PolicyError(`unsupported environment action: ${action}`);
}

async function runDaemonCommand(config) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const activityAdmission = process.platform === 'linux'
      ? await createLinuxActivityAdmission({
          access: 'shared',
          stateDirectory: config.state.directory,
          platform: 'linux',
        })
      : null;
    await runDaemon(config, {
      signal: controller.signal,
      activityAdmission,
      onEvent: (event) => console.log(JSON.stringify(event)),
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    usage();
    process.exitCode = 2;
    return;
  }

  if (command === 'setup') {
    const selected = parseSetupCommandOptions(args, { authorityHome: process.env.DEVBRIDGE_HOME });
    if (selected.lifecycleAuthorityChild) {
      const result = await runWindowsLifecycleAuthoritySetupChild({ env: process.env, output: process.stdout });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ready) process.exitCode = 3;
      return;
    }
    let setupHome = selected.home;
    if (selected.trackRef != null) {
      try {
        setupHome = trackInstalledRunnerRef({ home: selected.home, ref: selected.trackRef }).home;
      } catch (error) {
        throw new PolicyError(`could not persist setup runner ref: ${error.message}`);
      }
    }
    const result = await runDevBridgeSetup({
      home: setupHome,
      requestedRepositories: selected.repositories.length > 0 ? selected.repositories : null,
      construct: selected.construct,
      retireConflict: selected.retireConflict,
    });
    process.stdout.write(formatSetupHandoff(result));
    if (result.blocked) process.exitCode = 3;
    return;
  }

  const file = configPath(args);
  if (!file) {
    usage();
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig(file);
  const requestedRepository = optionValue(args, '--repository');
  const repository = selectConfiguredQueue(config, requestedRepository);
  if (command === 'environment') {
    console.log(JSON.stringify(await runEnvironmentCommand(config, args), null, 2));
    return;
  }
  if (command === 'handoff-status') {
    console.log(JSON.stringify(await chatHandoffStatus(config, repository), null, 2));
    return;
  }
  if (command === 'handoff-seed') {
    const seed = await chatHandoffSeed(config, repository);
    if (!seed) {
      console.log(JSON.stringify({ ready: false, repository }));
      process.exitCode = 3;
      return;
    }
    console.log(seed);
    return;
  }
  if (command === 'handoff-project') {
    const runtime = await createRuntime(config, { queueRepository: repository });
    const latest = await runtime.chatHandoffStore.loadLatest(repository);
    if (!latest) {
      console.log(JSON.stringify({ projected: false, reason: 'no-ready-handoff', repository }));
      process.exitCode = 3;
      return;
    }
    const issueNumber = integerOption(args, '--issue') ?? latest.record.handoff.issueNumber;
    if (!issueNumber) throw new PolicyError('handoff-project requires --issue or a handoff bound to an issue number');
    console.log(JSON.stringify(await runtime.chatHandoffProjector.project({ issueNumber, record: latest.record }), null, 2));
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await daemonStatus(daemonLockPath(config)), null, 2));
    return;
  }
  if (command === 'pause') {
    const result = await pauseDaemon(daemonLockPath(config));
    console.log(JSON.stringify(result, null, 2));
    if (result.activeLock && !result.paused) process.exitCode = 3;
    return;
  }
  if (command === 'resume') {
    const result = await resumeDaemon(daemonLockPath(config));
    console.log(JSON.stringify(result, null, 2));
    if (result.activeLock && !result.resumed) process.exitCode = 3;
    return;
  }
  if (command === 'stop') {
    const result = await stopDaemon(daemonLockPath(config));
    console.log(JSON.stringify(result, null, 2));
    if (result.activeLock && !result.stopped) process.exitCode = 3;
    return;
  }
  if (command === 'restart') {
    const result = await stopDaemon(daemonLockPath(config));
    if (result.activeLock && !result.stopped) {
      throw new PolicyError('daemon stop was requested but the existing daemon did not exit within the control timeout');
    }
    await runDaemonCommand(config);
    return;
  }
  if (command === 'doctor') {
    const environmentOperator = createConfiguredLifecycleAuthorityClient({ stateDirectory: config.state.directory });
    console.log(JSON.stringify(await doctor(config, {
      checkRepositoryAdmission: true,
      repositoryAdmissionTargets: requestedRepository == null ? config.github.queueRepositories : [repository],
      environmentOperator,
    }), null, 2));
    return;
  }
  if (command === 'poll-once') {
    const result = await pollOnce(config);
    const safe = {
      ...result,
      tasks: result.tasks.map((task) => ({
        queueRepository: task.queueRepository,
        issueNumber: task.issueNumber,
        revision: task.revision,
        targetRepository: task.envelope.target.repository,
        preferredTool: task.envelope.preferredTool,
        requestedCapabilities: task.envelope.requestedCapabilities,
        projectDir: task.projectDir,
      })),
    };
    console.log(JSON.stringify(safe, null, 2));
    return;
  }
  if (command === 'run-once') {
    console.log(JSON.stringify(await runOnce(config), null, 2));
    return;
  }
  if (command === 'daemon') {
    await runDaemonCommand(config);
    return;
  }

  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(`${error.name}: ${error.message}`);
  if (error.retryAt) console.error(`retryAt=${new Date(error.retryAt).toISOString()}`);
  process.exitCode = 1;
});
