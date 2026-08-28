import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvironmentBridge } from '../runtime/environment-bridge.js';
import { RepositoryEnvironmentExecution } from '../runtime/repository-environment-execution.js';
import {
  REPOSITORY_EXECUTION_STATUS_PROTOCOL,
  UnavailableRepositoryExecution,
} from '../runtime/repository-execution.js';
import {
  FILE_TREE_PART_BYTES,
  applyStagedFileTreeDelta,
  normalizeFileTreeDelta,
  snapshotFileTree,
  stageFileTreeDelta,
} from '../runtime/file-tree-transfer.js';
import {
  environmentActivityRouteForSubject,
  loadEnvironmentActivityPolicy,
  normalizeEnvironmentActivityPolicy,
} from '../runtime/environment-activity-policy.js';
import { ByteChannel } from './repository-execution/byte-channel.js';
import { OperationMaterializer } from './repository-execution/operation-materializer.js';
import { RouteAccess } from './repository-execution/route-access.js';
import { acquireSessionGuard } from './repository-execution/session-guard.js';
import { WorkspaceSession } from './repository-execution/workspace-session.js';

const BRIDGE_OUTPUT_LIMIT = 3 * 1024 * 1024;
const TRANSFER_LIMIT = 16 * 1024 * 1024;
const MANIFEST_LIMIT = 24 * 1024 * 1024;
const AGENT_FILE = fileURLToPath(new URL('../guest/workspace-agent.mjs', import.meta.url));
const RESOURCE_AGENT_FILE = fileURLToPath(new URL('../guest/resource-agent.mjs', import.meta.url));

function hashIdentity(value) { return `execution-${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`; }
function repositoryPathAllowed(relative) { const first = String(relative).replace(/\\/gu, '/').split('/')[0]; return first !== '.git' && first !== '.devbridge'; }
function splitNul(text) { return String(text).split('\0').filter(Boolean); }
function parseAgentResult(outcome, action) {
  if (!outcome || outcome.completion !== 'observed') throw new Error(`${action} completion is not observed`);
  const result = outcome.result;
  if (!result || result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) {
    throw new Error(String(result?.stderr || result?.stdout || `${action} failed`).trim().slice(0, 2048));
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error(`${action} returned invalid structured output`); }
}

function activityComponents(raw) {
  const methods = ['inspect', 'list', 'observe', 'prepare', 'exchange'];
  if (!raw || methods.some((name) => typeof raw[name] !== 'function')) {
    throw new TypeError('repository execution activity contract is incomplete');
  }
  return Object.freeze({
    state: Object.freeze({
      inspect: () => raw.inspect(),
      listEnvironments: () => raw.list(),
      observeEnvironment: (target) => raw.observe(target),
    }),
    preparation: Object.freeze({ ensure: (target) => raw.prepare(target) }),
    channel: new EnvironmentBridge({ exchange: (frame, options) => raw.exchange(frame, options) }),
  });
}

export async function createRepositoryExecution({
  stateDirectory,
  routes = null,
  rootFor,
  listPaths,
  resolveSubject,
  resolveTool,
  protectedValues = [],
  activity = null,
  createState = null,
  createPreparation = null,
  createChannel = null,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('repository execution stateDirectory is required');
  if (typeof rootFor !== 'function' || typeof listPaths !== 'function' || typeof resolveSubject !== 'function' || typeof resolveTool !== 'function') {
    throw new TypeError('repository execution composition contracts are incomplete');
  }
  if (!Array.isArray(protectedValues) || protectedValues.some((value) => typeof value !== 'string')) throw new TypeError('repository execution protectedValues must be strings');
  const protectedEnvironmentValues = protectedValues.filter((value) => value.length >= 8);
  const policy = routes == null ? await loadEnvironmentActivityPolicy(stateDirectory) : normalizeEnvironmentActivityPolicy(routes);
  if (!policy || policy.routes.length === 0) return new UnavailableRepositoryExecution({ reason: 'no local persistent-environment execution routes are configured' });
  let components;
  if (activity != null) components = activityComponents(activity);
  else if ([createState, createPreparation, createChannel].every((value) => typeof value === 'function')) {
    components = Object.freeze({
      state: await createState({ stateDirectory }),
      preparation: await createPreparation({ stateDirectory }),
      channel: await createChannel({ stateDirectory }),
    });
  } else {
    return new UnavailableRepositoryExecution({ reason: 'protected environment activity authority is not configured' });
  }
  const { state, preparation, channel } = components;
  if (!state || ['inspect', 'listEnvironments', 'observeEnvironment'].some((name) => typeof state[name] !== 'function')) {
    throw new TypeError('repository execution state contract is incomplete');
  }
  if (!preparation || typeof preparation.ensure !== 'function') throw new TypeError('repository execution preparation contract is incomplete');
  if (!channel || ['health', 'execute', 'put', 'get'].some((name) => typeof channel[name] !== 'function')) {
    throw new TypeError('repository execution channel contract is incomplete');
  }
  let observed;
  try { observed = await state.inspect(); }
  catch {
    if (activity != null) return new UnavailableRepositoryExecution({ reason: 'protected environment activity authority is unavailable' });
    throw new Error('repository execution state inspection failed');
  }
  if (observed?.ready !== true) return new UnavailableRepositoryExecution({ reason: observed?.reason ?? 'environment foundation is not ready' });
  let known;
  try { known = await state.listEnvironments(); }
  catch {
    if (activity != null) return new UnavailableRepositoryExecution({ reason: 'protected environment activity authority is unavailable' });
    throw new Error('repository execution environment listing failed');
  }
  const routed = known.filter((entry) => policy.routes.some((route) => route.subject === entry.record?.subject && route.profile === entry.record?.profile) && entry.observation?.exists && entry.observation?.owned && entry.observation?.compatible);
  if (routed.length === 0) return new UnavailableRepositoryExecution({ reason: 'no routed persistent environment is present and compatible' });

  const status = {
    protocol: REPOSITORY_EXECUTION_STATUS_PROTOCOL,
    state: 'ready', ready: true,
    identity: hashIdentity({ foundation: observed.identity, routes: policy.routes.map((route) => [route.subject, route.profile]) }).slice(0, 128),
    reason: null,
  };
  const agentBytes = await readFile(AGENT_FILE);
  const resourceAgentBytes = await readFile(RESOURCE_AGENT_FILE);
  const stagingRoot = path.join(path.resolve(stateDirectory), 'repository-execution', 'staging');
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const access = new RouteAccess({
    policy,
    identify: resolveSubject,
    select: environmentActivityRouteForSubject,
    list: () => state.listEnvironments(),
    root: rootFor,
    canonicalize: (value) => realpath(path.resolve(value)),
    inspect: lstat,
    messages: {
      subjectName: 'repository execution subject',
      absent: 'routed persistent environment is absent',
      ambiguous: 'routed persistent environment is ambiguous',
      unavailable: 'routed persistent environment is unavailable',
      invalidRoot: 'repository source root must be a real directory',
    },
  });

  return new RepositoryEnvironmentExecution({
    status,
    open: async (scope) => {
      const { subject, route, target, root } = await access.resolve(scope);
      const releaseSession = await acquireSessionGuard({
        directory: path.join(path.resolve(stateDirectory), 'repository-execution', 'locks'),
        identity: target,
        conflictMessage: 'the selected execution environment already has an active session',
        ownershipMessage: 'execution session ownership changed before release',
      });
      const agentLocation = { class: 'input', path: 'control/workspace-agent.mjs' };
      const resourceAgentLocation = { class: 'input', path: 'control/resource-agent.mjs' };
      const stateLocation = { class: 'cache', path: 'source-state.json' };
      const sourceManifestLocation = { class: 'input', path: 'source/manifest.json' };
      const candidateDirectory = { class: 'output', path: 'candidate' };
      const scratchRoot = `subjects/${subject}/runs/${scope.runId}`;
      const scratchRunLocation = { class: 'scratch', path: scratchRoot };
      const bytes = new ByteChannel({
        target,
        put: (...args) => channel.put(...args),
        get: (...args) => channel.get(...args),
        limit: TRANSFER_LIMIT,
        messages: {
          offset: 'execution output transfer offset is not contiguous',
          limit: 'execution output transfer exceeded its limit',
        },
      });
      const materializer = new OperationMaterializer({
        write: (value, location) => bytes.write(value, location),
        protectedValues: protectedEnvironmentValues,
        scratchRoot,
        messages: {
          program: 'logical tool did not resolve to a safe guest program',
          arguments: 'logical tool fixed arguments are invalid',
          scratchRoot: 'operation scratch root is unavailable',
          transfer: 'operation argument transfer is not registered',
          protectedValue: 'operation environment contains a protected control-plane value',
          resourcePath: 'tool resource path is invalid',
          normalizedResourcePath: 'tool resource path is not a normalized relative path',
          resources: 'logical tool resources are invalid',
          entryRequiresResources: 'logical tool entry requires resources',
          resource: 'logical tool resource is invalid',
          duplicateResource: 'logical tool resource path is duplicated',
          resourceLimit: 'logical tool resources exceed their bound',
          missingEntry: 'logical tool entry is not present in its resources',
          descriptorLimit: 'repository operation descriptor exceeds the bounded staging limit',
        },
      });

      const runAgent = async (action, argumentsList, { directory = '.', timeoutMs = 120_000, maxOutputBytes = 256 * 1024, signal = null, onActivity = null } = {}) => {
        const outcome = await channel.execute(target, {
          program: 'node',
          arguments: [agentLocation, action, ...argumentsList],
          directory: { class: 'work', path: directory },
          environment: {}, input: null, timeoutMs, maxOutputBytes,
        }, { signal, onActivity, pollIntervalMs: 500 });
        return parseAgentResult(outcome, `workspace ${action}`);
      };

      const snapshot = async () => snapshotFileTree({
        root,
        listPaths: async (canonicalRoot) => listPaths(canonicalRoot, structuredClone(scope)),
        acceptPath: repositoryPathAllowed,
      });

      return new WorkspaceSession({
        activity: {
          prepare: () => preparation.ensure(target),
          health: () => channel.health(target),
        },
        source: {
          snapshot,
          install: () => bytes.write(agentBytes, agentLocation),
          observe: (digest, options) => runAgent('prepare', [stateLocation, digest], { timeoutMs: 60_000, ...options }),
          writePart: (part, read) => bytes.stream({ read }, { class: 'input', path: `source/${part.name}` }, { maxBytes: Math.max(1, part.size) }),
          writeManifest: (value) => bytes.write(value, sourceManifestLocation),
          apply: (options) => runAgent('apply', [sourceManifestLocation, stateLocation], { timeoutMs: 10 * 60_000, ...options }),
        },
        input: (name, port) => bytes.ingest(port, { class: 'input', path: `ports/${name}` }),
        operation: {
          stage: async ({ invocation, environment, stdin, transfers }) => materializer.stage({
            invocation,
            resolved: await resolveTool(invocation.tool, { subject, profile: route.profile, scope: structuredClone(scope) }),
            environment,
            stdin,
            transfers,
          }),
          execute: ({ location, arguments: locations, directory, limits, signal, onActivity }) => channel.execute(target, {
            program: 'node',
            arguments: [agentLocation, 'run', location, ...locations],
            directory: { class: 'work', path: directory },
            environment: {}, input: null,
            timeoutMs: limits.timeoutMs,
            maxOutputBytes: Math.min(limits.maxOutputBytes, BRIDGE_OUTPUT_LIMIT),
          }, { signal, onActivity }),
        },
        output: (name, port) => bytes.emit({ class: 'output', path: `ports/${name}` }, port),
        candidate: {
          accepts: (operation) => !(typeof operation === 'string' && (operation.startsWith('tool.probe:') || operation.startsWith('runtime.validate:'))),
          collect: ({ signal }) => runAgent('collect', [candidateDirectory, stateLocation], { timeoutMs: 5 * 60_000, signal }),
          readManifest: async () => {
            const value = await bytes.read({ class: 'output', path: 'candidate/manifest.json' }, MANIFEST_LIMIT);
            let raw;
            try { raw = JSON.parse(value.toString('utf8')); } catch { throw new Error('guest candidate manifest is invalid JSON'); }
            return normalizeFileTreeDelta(raw, { root, acceptPath: repositoryPathAllowed });
          },
          createStage: () => path.join(stagingRoot, scope.runId, randomUUID()),
          stage: ({ manifest, stage, active }) => stageFileTreeDelta({
            manifest,
            root,
            stagingRoot: stage,
            acceptPath: repositoryPathAllowed,
            readPart: async (name) => {
              active();
              return bytes.read({ class: 'output', path: `candidate/${name}` }, FILE_TREE_PART_BYTES);
            },
          }),
          apply: ({ manifest, stage, signal }) => applyStagedFileTreeDelta({
            root,
            stagingRoot: stage,
            manifest,
            acceptPath: repositoryPathAllowed,
            signal,
          }),
          discard: (stage) => rm(stage, { recursive: true, force: true }),
        },
        resource: {
          assert: (resource) => {
            if (resource !== 'scratch') throw new Error('repository execution cleanup resource is unsupported');
          },
          remove: async (resource, { signal }) => {
            await bytes.write(resourceAgentBytes, resourceAgentLocation);
            const outcome = await channel.execute(target, {
              program: 'node',
              arguments: [resourceAgentLocation, 'remove-directory', scratchRunLocation],
              directory: { class: 'work', path: '.' },
              environment: {}, input: null, timeoutMs: 120_000, maxOutputBytes: 64 * 1024,
            }, { signal, pollIntervalMs: 500 });
            return parseAgentResult(outcome, 'resource cleanup');
          },
        },
        messages: {
          activityUnavailable: 'environment exchange is not ready',
          sourceApplyMismatch: 'guest source synchronization did not bind the expected digest',
          sourceChangedDuringSync: 'authoritative source changed during guest synchronization',
          notPrepared: 'repository execution session was not prepared',
          evidenceChanged: 'repository execution evidence identity changed before candidate collection',
          sourceChangedDuringWork: 'authoritative source changed during repository execution; guest result is stale',
          staleCandidate: 'guest candidate is based on stale source identity',
          sourceChangedBeforeApply: 'authoritative source drifted before candidate import',
          cleanupUnverified: 'resource cleanup did not verify absence',
        },
        identify: (value) => {
          if (Object.hasOwn(value, 'resource')) {
            return hashIdentity({ target, subject, runId: scope.runId, resource: value.resource }).slice(0, 128);
          }
          return hashIdentity({ target, bootstrap: value.generation, bridge: value.version, source: value.source }).slice(0, 128);
        },
        close: releaseSession,
      });
    },
  });
}

export function gitVisiblePathsFromResult(result) {
  return splitNul(result?.stdout ?? '');
}
