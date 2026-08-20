#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEnvironmentBridge } from '../../src/app/environment-bridge.js';
import { createEnvironmentFoundation } from '../../src/app/environment-foundation.js';
import { createFastVmTopology } from '../../src/app/fast-vm-repository-execution.js';
import {
  ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
  normalizeEnvironmentExecutionRoutes,
  repositoryExecutionRoutesPath,
} from '../../src/app/repository-execution.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

async function writeOrMatch(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return 'created';
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (await readFile(file, 'utf8') !== content) throw new Error(`existing local policy differs: ${file}`);
    return 'matched';
  }
}

async function readRoutePolicy(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
      throw new Error(`existing local route policy is not a bounded real file: ${file}`);
    }
    return normalizeEnvironmentExecutionRoutes(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function routeMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function upsertRoutePolicy(file, route) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  let lock;
  try {
    lock = await open(lockFile, 'wx', 0o600);
    await lock.writeFile(`${randomUUID()}\n`, 'utf8');
  } catch (error) {
    await lock?.close().catch(() => {});
    if (error?.code === 'EEXIST') throw new Error(`local route policy is being changed by another process: ${file}`);
    throw error;
  }

  try {
    const current = await readRoutePolicy(file);
    const existing = current?.routes.find((entry) => entry.subject === route.subject && entry.profile === route.profile) ?? null;
    const intended = normalizeEnvironmentExecutionRoutes({
      protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
      routes: current?.routes ?? [],
    });
    const normalizedRoute = {
      ...route,
      validation: existing?.validation ?? !intended.routes.some((entry) => entry.validation),
    };
    if (existing) {
      if (!routeMatches(existing, normalizedRoute)) throw new Error(`existing local route differs for subject/profile: ${route.subject}/${route.profile}`);
      return 'matched';
    }

    const next = normalizeEnvironmentExecutionRoutes({
      protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
      routes: [...intended.routes, normalizedRoute],
    });
    const content = `${JSON.stringify(next)}\n`;
    if (current == null) {
      await writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return 'created';
    }
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return 'extended';
  } finally {
    await lock.close().catch(() => {});
    await rm(lockFile, { force: true });
  }
}

const stateDirectory = path.resolve(argument('--state-directory'));
const identityFile = path.resolve(argument('--identity-file'));
const sourceKnownHostsFile = path.resolve(argument('--source-known-hosts-file'));
const knownHostsFile = path.resolve(argument('--known-hosts-file'));
const sourceIdentity = argument('--source-identity');
const subject = argument('--subject');
const profile = 'linux-development';

if (!/^\d+$/u.test(subject)) throw new Error('repository subject must be a numeric immutable identity');
if (!/^img-[a-f0-9]{32}$/u.test(sourceIdentity)) throw new Error('source identity is invalid');

const foundation = await createEnvironmentFoundation({ stateDirectory });
const storage = await foundation.ensureStorage();
if (storage.ready !== true) throw new Error('owned environment storage did not become ready');

const environment = await foundation.ensureEnvironment({
  subject,
  profile,
  sourceIdentity,
  settings: {
    memoryBytes: 4 * 1024 * 1024 * 1024,
    processorCount: 4,
    firmware: 'efi',
  },
});

const baseAccess = async () => ({
  family: 'linux',
  user: 'devbridge',
  identityFile,
  knownHostsFile,
});
const topology = createFastVmTopology({ stateDirectory, access: baseAccess });
const connection = await topology.connection(environment.record.identity);

const sourceHostLine = (await readFile(sourceKnownHostsFile, 'utf8')).trim();
const hostParts = sourceHostLine.split(/\s+/u);
if (hostParts.length < 3 || !hostParts[1].startsWith('ssh-')) throw new Error('source guest host-key record is invalid');
hostParts[0] = '*';
const knownHostsState = await writeOrMatch(knownHostsFile, `${hostParts.join(' ')}\n`);

const route = {
  protocol: ENVIRONMENT_EXECUTION_ROUTES_PROTOCOL,
  routes: [{
    subject,
    profile,
    preferred: true,
    validation: false,
    access: {
      family: 'linux',
      user: 'devbridge',
      identityFile,
      knownHostsFile,
    },
  }],
};
const routesFile = repositoryExecutionRoutesPath(stateDirectory);
const routesState = await upsertRoutePolicy(routesFile, route.routes[0]);
const readiness = await topology.ensure(environment.record.identity);
const bridge = await createEnvironmentBridge({ stateDirectory, access: (target) => topology.connection(target) });
const health = await bridge.health(environment.record.identity);
if (health.ready !== true) throw new Error(health.reason ?? 'fast VM bridge did not become ready');
const observed = await foundation.observeEnvironment(environment.record.identity);

process.stdout.write(`${JSON.stringify({
  networking: { ready: true, mode: 'fast-default-switch' },
  storage,
  environment: observed,
  connection,
  knownHosts: { file: knownHostsFile, state: knownHostsState },
  routes: { file: routesFile, state: routesState },
  readiness,
  health,
})}\n`);
