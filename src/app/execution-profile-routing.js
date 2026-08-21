import { createHash } from 'node:crypto';
import { createEnvironmentBootstrap } from './environment-bootstrap.js';
import { createEnvironmentBridge } from './environment-bridge.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import {
  createRepositoryExecution,
  loadEnvironmentExecutionRoutes,
  normalizeEnvironmentExecutionRoutes,
} from './repository-execution.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const MAX_SUBJECT_BYTES = 512;

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function opaqueSubject(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SUBJECT_BYTES) {
    throw new TypeError('workspace subject must be a bounded opaque identity');
  }
  return value;
}

function digest(namespace, ...parts) {
  const hash = createHash('sha256').update(namespace, 'utf8');
  for (const part of parts) hash.update('\0', 'utf8').update(String(part), 'utf8');
  return hash.digest('hex');
}

export function executionProfileSubject(profile) {
  const normalized = safeId(profile, 'execution profile');
  return `profile-${digest('execution-profile-v1', normalized).slice(0, 32)}`;
}

export function executionWorkspaceIdentity(subject, profile) {
  return `workspace-${digest('execution-workspace-v1', opaqueSubject(subject), safeId(profile, 'execution profile')).slice(0, 32)}`;
}

export function executionWorkspaceTarget(subject, profile) {
  return `env-${digest('execution-workspace-target-v1', opaqueSubject(subject), safeId(profile, 'execution profile')).slice(0, 32)}`;
}

function profileAccessKey(route) {
  return JSON.stringify(route.access ?? {});
}

function validateProfileAccess(policy) {
  const seen = new Map();
  for (const route of policy.routes) {
    const current = profileAccessKey(route);
    const prior = seen.get(route.profile);
    if (prior != null && prior !== current) {
      throw new Error(`execution profile ${route.profile} has conflicting guest-access configuration`);
    }
    seen.set(route.profile, current);
  }
}

function routeIndex(policy) {
  const byTarget = new Map();
  const byProfile = new Map();
  for (const route of policy.routes) {
    const target = executionWorkspaceTarget(route.subject, route.profile);
    if (byTarget.has(target)) throw new Error('execution workspace target identity collided');
    byTarget.set(target, route);
    if (!byProfile.has(route.profile)) byProfile.set(route.profile, []);
    byProfile.get(route.profile).push({ route, target });
  }
  return { byTarget, byProfile };
}

function syntheticEntry(route, target, physical) {
  return Object.freeze({
    record: Object.freeze({
      ...structuredClone(physical.record),
      identity: target,
      subject: route.subject,
      profile: route.profile,
    }),
    observation: Object.freeze({
      ...structuredClone(physical.observation),
      identity: target,
    }),
  });
}

function profileMatches(environments, profile) {
  const subject = executionProfileSubject(profile);
  return environments.filter((entry) => entry.record?.subject === subject && entry.record?.profile === profile);
}

export function createExecutionProfileRouting({ state, policy }) {
  if (!state || typeof state.inspect !== 'function' || typeof state.listEnvironments !== 'function' || typeof state.observeEnvironment !== 'function') {
    throw new TypeError('execution-profile state contract is incomplete');
  }
  const normalized = normalizeEnvironmentExecutionRoutes(policy);
  validateProfileAccess(normalized);
  const index = routeIndex(normalized);

  const physicalForRoute = async (route) => {
    const matches = profileMatches(await state.listEnvironments(), route.profile);
    if (matches.length > 1) throw new Error(`execution profile ${route.profile} has multiple persistent environments`);
    return matches[0] ?? null;
  };

  const routeForTarget = (target) => {
    const route = index.byTarget.get(target);
    if (!route) throw new Error('execution workspace target is not admitted by local profile routing');
    return route;
  };

  const physicalTarget = async (target) => {
    const route = routeForTarget(target);
    const physical = await physicalForRoute(route);
    if (!physical) throw new Error(`execution profile ${route.profile} has no persistent environment`);
    return physical.record.identity;
  };

  const representativeTarget = async (rawPhysicalTarget) => {
    const observed = await state.observeEnvironment(rawPhysicalTarget);
    const profile = observed?.record?.profile;
    const expectedSubject = profile ? executionProfileSubject(profile) : null;
    if (!profile || observed?.record?.subject !== expectedSubject) throw new Error('persistent environment is not owned by an execution profile');
    const routes = index.byProfile.get(profile) ?? [];
    if (routes.length < 1) throw new Error(`execution profile ${profile} has no admitted workspace routes`);
    return routes[0].target;
  };

  return Object.freeze({
    inspect: () => state.inspect(),
    async listEnvironments() {
      const physical = await state.listEnvironments();
      const result = [];
      for (const [target, route] of index.byTarget) {
        const matches = profileMatches(physical, route.profile);
        if (matches.length > 1) throw new Error(`execution profile ${route.profile} has multiple persistent environments`);
        if (matches.length === 1) result.push(syntheticEntry(route, target, matches[0]));
      }
      return result;
    },
    async observeEnvironment(target) {
      const route = routeForTarget(target);
      const physical = await physicalForRoute(route);
      if (!physical) throw new Error(`execution profile ${route.profile} has no persistent environment`);
      const observed = await state.observeEnvironment(physical.record.identity);
      return syntheticEntry(route, target, observed);
    },
    physicalTarget,
    representativeTarget,
    workspaceIdentity(target) {
      const route = routeForTarget(target);
      return executionWorkspaceIdentity(route.subject, route.profile);
    },
    profileForTarget(target) {
      return routeForTarget(target).profile;
    },
  });
}

function scopedLocation(location, workspace) {
  if (!location || typeof location !== 'object' || Array.isArray(location)) return location;
  const value = String(location.path ?? '.');
  return {
    ...location,
    path: value === '.' ? `workspaces/${workspace}` : `workspaces/${workspace}/${value}`,
  };
}

function scopedOperation(operation, workspace) {
  return {
    ...operation,
    directory: scopedLocation(operation.directory, workspace),
    arguments: (operation.arguments ?? []).map((entry) => typeof entry === 'string' ? entry : scopedLocation(entry, workspace)),
  };
}

export function createWorkspaceScopedChannel({ channel, routing }) {
  if (!channel || typeof channel.health !== 'function' || typeof channel.execute !== 'function' || typeof channel.put !== 'function' || typeof channel.get !== 'function') {
    throw new TypeError('workspace channel contract is incomplete');
  }
  if (!routing || typeof routing.physicalTarget !== 'function' || typeof routing.workspaceIdentity !== 'function') {
    throw new TypeError('workspace routing contract is incomplete');
  }
  const resolve = async (target) => ({
    physical: await routing.physicalTarget(target),
    workspace: routing.workspaceIdentity(target),
  });
  return Object.freeze({
    async health(target) {
      const selected = await resolve(target);
      return channel.health(selected.physical);
    },
    async execute(target, operation, options) {
      const selected = await resolve(target);
      return channel.execute(selected.physical, scopedOperation(operation, selected.workspace), options);
    },
    async put(target, source, destination, options) {
      const selected = await resolve(target);
      return channel.put(selected.physical, source, scopedLocation(destination, selected.workspace), options);
    },
    async get(target, source, sink, options) {
      const selected = await resolve(target);
      return channel.get(selected.physical, scopedLocation(source, selected.workspace), sink, options);
    },
  });
}

function createMappedPreparation(preparation, routing) {
  const map = (target) => routing.physicalTarget(target);
  return Object.freeze({
    inspect: typeof preparation.inspect === 'function' ? async (target) => preparation.inspect(await map(target)) : undefined,
    ensure: async (target) => preparation.ensure(await map(target)),
    verifyContinuity: typeof preparation.verifyContinuity === 'function'
      ? async (target) => preparation.verifyContinuity(await map(target))
      : undefined,
    connection: typeof preparation.connection === 'function'
      ? async (target) => preparation.connection(await map(target))
      : undefined,
    reconcile: typeof preparation.reconcile === 'function' ? (...args) => preparation.reconcile(...args) : undefined,
  });
}

export async function createExecutionProfileRepositoryExecution({
  stateDirectory,
  routes = null,
  createState = createEnvironmentFoundation,
  createPreparation = createEnvironmentBootstrap,
  createChannel = createEnvironmentBridge,
  ...options
} = {}) {
  const policy = routes == null ? await loadEnvironmentExecutionRoutes(stateDirectory) : normalizeEnvironmentExecutionRoutes(routes);
  let routing = null;

  const routedStateFactory = async (input) => {
    const state = await createState(input);
    if (!policy) return state;
    routing = createExecutionProfileRouting({ state, policy });
    return routing;
  };

  const routedPreparationFactory = async (input) => {
    if (!routing) throw new Error('execution-profile routing state was not initialized');
    const preparation = await createPreparation({
      ...input,
      access: async (physical) => input.access(await routing.representativeTarget(physical)),
    });
    return createMappedPreparation(preparation, routing);
  };

  const routedChannelFactory = async (input) => {
    if (!routing) throw new Error('execution-profile routing state was not initialized');
    const channel = await createChannel({
      ...input,
      access: async (physical) => input.access(await routing.representativeTarget(physical)),
    });
    return createWorkspaceScopedChannel({ channel, routing });
  };

  return createRepositoryExecution({
    stateDirectory,
    routes: policy,
    ...options,
    createState: routedStateFactory,
    createPreparation: routedPreparationFactory,
    createChannel: routedChannelFactory,
  });
}
