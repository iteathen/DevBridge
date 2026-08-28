import {
  createExecutionProfileRouting,
  createWorkspaceScopedChannel,
  executionWorkspaceIdentity,
  executionWorkspaceTarget,
} from './execution-profile-routing.js';
import {
  ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,
  loadEnvironmentActivityPolicy,
  normalizeEnvironmentActivityPolicy,
  publishEnvironmentActivityPolicy,
} from '../runtime/environment-activity-policy.js';

const STABLE_SUBJECT = /^\d+$/u;
const READY_BYTES = Buffer.from('ready\n', 'utf8');

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function assertChannel(value) {
  if (!value || ['health', 'execute', 'put', 'get'].some((name) => typeof value[name] !== 'function')) throw new TypeError('environment workspace channel contract is incomplete');
  return value;
}

function sourceFor(bytes) {
  const value = Buffer.from(bytes);
  return Object.freeze({
    async read({ offset, limit }) {
      const end = Math.min(value.length, offset + limit);
      return Object.freeze({ data: value.subarray(offset, end), eof: end === value.length });
    },
  });
}

function observed(outcome, name) {
  if (!outcome || outcome.completion !== 'observed') throw new Error(`${name} completion is not observed`);
  const result = outcome.result;
  if (!result || result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) {
    throw new Error(String(result?.stderr || result?.stdout || `${name} failed`).trim().slice(0, 2048));
  }
}

function admitRoute(routes, { subject, profile }) {
  const matches = routes.filter((route) => route.subject === subject);
  const exact = matches.filter((route) => route.profile === profile);
  if (exact.length > 1) throw new Error('environment workspace route is ambiguous');
  const preferred = matches.filter((route) => route.preferred);
  if (preferred.length > 1) throw new Error('environment workspace route preference is ambiguous');
  if (matches.length > 1 && preferred.length === 0) throw new Error('environment workspace routes have no unique preferred profile');

  let changed = false;
  if (matches.length === 1 && preferred.length === 0) {
    matches[0].preferred = true;
    changed = true;
  }
  if (exact.length === 0) {
    routes.push({ subject, profile, preferred: matches.length === 0, validation: false });
    changed = true;
  }
  return changed;
}

export function createEnvironmentConstructionWorkspaces({
  stateDirectory,
  state,
  channel = null,
  resolveChannel = null,
  resolveAuthority,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment workspace stateDirectory is required');
  if (!state || typeof state.listEnvironments !== 'function' || typeof state.observeEnvironment !== 'function' || typeof state.inspect !== 'function') throw new TypeError('environment workspace state contract is incomplete');
  if (channel == null && typeof resolveChannel !== 'function') throw new TypeError('environment workspace channel contract is incomplete');
  if (channel != null) assertChannel(channel);
  if (resolveChannel != null && typeof resolveChannel !== 'function') throw new TypeError('environment workspace channel resolver is invalid');
  if (typeof resolveAuthority !== 'function') throw new TypeError('environment workspace authority contract is incomplete');

  const resolve = async (rawRequest) => {
    const request = requireObject(rawRequest, 'environment workspace request');
    const declaration = requireObject(request.declaration, 'environment workspace declaration');
    const workspaces = request.workspaces ?? declaration.workspaces;
    if (!Array.isArray(workspaces) || JSON.stringify(workspaces) !== JSON.stringify(declaration.workspaces)) throw new Error('environment workspaces no longer match declaration authority');
    const selected = [];
    for (const workspace of workspaces) {
      const subject = String(await resolveAuthority(workspace.authority));
      if (!STABLE_SUBJECT.test(subject)) throw new Error('environment workspace authority did not resolve to a stable subject');
      if (executionWorkspaceIdentity(subject, declaration.profile) !== workspace.identity) throw new Error('environment workspace identity does not match host authority');
      selected.push(Object.freeze({ subject, workspace, target: executionWorkspaceTarget(subject, declaration.profile) }));
    }

    const existing = await loadEnvironmentActivityPolicy(stateDirectory);
    const routes = existing ? existing.routes.map((route) => structuredClone(route)) : [];
    let changed = false;
    for (const entry of selected) {
      if (admitRoute(routes, { subject: entry.subject, profile: declaration.profile })) changed = true;
    }
    const policy = normalizeEnvironmentActivityPolicy({ protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes });
    const selectedChannel = assertChannel(channel ?? await resolveChannel(Object.freeze({ declaration })));
    const routing = createExecutionProfileRouting({ state, policy });
    const scoped = createWorkspaceScopedChannel({ channel: selectedChannel, routing });
    return { request, declaration, selected, policy, routing, scoped, changed };
  };

  const inspectRoots = async (resolved) => {
    for (const entry of resolved.selected) {
      const health = await resolved.scoped.health(entry.target);
      if (health?.ready !== true) throw new Error(health?.reason ?? 'environment workspace exchange is unavailable');
    }
    return Object.freeze({ ready: true, count: resolved.selected.length });
  };

  const verifyRoots = async (resolved) => {
    await inspectRoots(resolved);
    for (const entry of resolved.selected) {
      await resolved.scoped.put(entry.target, sourceFor(READY_BYTES), { class: 'input', path: 'lifecycle/ready' }, { maxBytes: READY_BYTES.length });
      const outcome = await resolved.scoped.execute(entry.target, {
        program: 'node',
        arguments: [
          '-e',
          'process.stdout.write("ready")',
          { class: 'output', path: 'lifecycle/ready' },
          { class: 'scratch', path: 'lifecycle/ready' },
          { class: 'cache', path: 'lifecycle/ready' },
        ],
        directory: { class: 'work', path: '.' },
        environment: {},
        input: null,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      }, { pollIntervalMs: 500 });
      observed(outcome, 'environment workspace preparation');
    }
    return Object.freeze({ ready: true, count: resolved.selected.length });
  };

  return Object.freeze({
    async ensure(request) {
      const resolved = await resolve(request);
      await verifyRoots(resolved);
      if (resolved.changed) await publishEnvironmentActivityPolicy(stateDirectory, resolved.policy);
      return Object.freeze({ ready: true, implementationGeneration: request.implementationGeneration, routesChanged: resolved.changed, workspaceCount: resolved.selected.length });
    },
    async inspect(request) {
      try {
        const resolved = await resolve(request);
        const status = await inspectRoots(resolved);
        return Object.freeze({ ...status, routeCount: resolved.policy.routes.length });
      } catch (error) {
        return Object.freeze({ ready: false, reason: String(error?.message ?? error).slice(0, 2048) });
      }
    },
  });
}
