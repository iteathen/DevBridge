import { createHash } from 'node:crypto';
import path from 'node:path';
import { createEnvironmentBridge } from './environment-bridge.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { EnvironmentBootstrap } from '../runtime/environment-bootstrap.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { loadOrCreateLocalIdentity } from '../runtime/local-identity.js';
import { HyperVEnvironmentBootstrap } from '../runtime/providers/hyperv-environment-bootstrap.js';
import { LibvirtEnvironmentBootstrap } from '../runtime/providers/libvirt-environment-bootstrap.js';

const DEFAULT_REQUIREMENTS = Object.freeze([
  'source-control',
  'runtime-js',
  'build-config',
  'test-runner',
  'compiler-c',
  'compiler-cxx',
  'package-project',
]);

const DEFAULT_PROTECTED_NAMES = Object.freeze([
  'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_ASKPASS', 'SSH_AUTH_SOCK',
  'DEVBRIDGE_GITHUB_TOKEN', 'DEVBRIDGE_COORDINATION_PRIVATE_KEY',
  'DEVBRIDGE_RELEASE_PRIVATE_KEY', 'DEVBRIDGE_SIGNING_KEY',
]);

function environmentReference(identity, target) {
  return `db-env-${createHash('sha256').update(`${identity}:persistent:${target}`).digest('hex').slice(0, 16)}`;
}

function environmentProof(identity, target) {
  return `devbridge-owned:${identity}:persistent:${target}:v1`;
}

function environmentIdentity(identity, target) {
  const hex = createHash('sha256').update(`${identity}:persistent:${target}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function networkReference(identity) {
  return `db-network-${createHash('sha256').update(`${identity}:network:`).digest('hex').slice(0, 16)}`;
}

function hypervNetworkProof(identity) {
  return `devbridge-owned:${identity}:network:default:v1`;
}

function libvirtNetworkProof(identity) {
  return `devbridge-owned:${identity}:network:v1`;
}

function hypervPrefix(identity) {
  const digest = createHash('sha256').update(`${identity}:network`).digest();
  const third = 64 + (digest[0] % 128);
  return { prefix: `192.168.${third}.0/24`, gateway: `192.168.${third}.1` };
}

function running(state) {
  return ['running', 'blocked'].includes(String(state ?? '').toLowerCase());
}

function stopped(state) {
  return ['stopped', 'shut off', 'off', 'shutdown', 'crashed'].includes(String(state ?? '').toLowerCase());
}

async function parseBootstrapOutput(outcome) {
  if (!outcome || outcome.completion !== 'observed') throw new Error('bootstrap exchange completion is not observed');
  const result = outcome.result;
  if (!result || result.timedOut || result.aborted || result.outputTruncated || result.exitCode !== 0) {
    throw new Error(String(result?.stderr || result?.stdout || 'bootstrap helper failed').trim().slice(0, 2_048));
  }
  if (result.stderr) throw new Error(`bootstrap helper wrote unexpected stderr: ${String(result.stderr).slice(0, 2_048)}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error('bootstrap helper returned invalid structured output'); }
}

export async function createEnvironmentBootstrap({
  stateDirectory,
  platform = process.platform,
  invoke = invokeCommand,
  access,
  requirements = DEFAULT_REQUIREMENTS,
  protectedNames = DEFAULT_PROTECTED_NAMES,
  revision = 'stage5-base-v1',
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('stateDirectory is required');
  if (typeof access !== 'function') throw new TypeError('bootstrap access must be a function');
  if (!Array.isArray(requirements) || !Array.isArray(protectedNames)) throw new TypeError('bootstrap policy lists are invalid');
  const root = path.join(path.resolve(stateDirectory), 'environment-foundation');
  const identity = await loadOrCreateLocalIdentity({ directory: root });
  const foundation = await createEnvironmentFoundation({ stateDirectory, platform, invoke });

  const baseAccess = async (target) => access(target);
  const location = async (target) => {
    const selected = await baseAccess(target);
    if (!selected || !['windows', 'linux'].includes(selected.family)) throw new TypeError('bootstrap access family is invalid');
    const common = {
      reference: environmentReference(identity, target),
      proof: environmentProof(identity, target),
      family: selected.family,
    };
    if (platform === 'win32') {
      return { ...common, network: { reference: networkReference(identity), proof: hypervNetworkProof(identity), ...hypervPrefix(identity) } };
    }
    if (platform === 'linux') {
      return { ...common, identity: environmentIdentity(identity, target), network: { reference: networkReference(identity), proof: libvirtNetworkProof(identity) } };
    }
    throw new Error('no bootstrap attachment is available for this host platform');
  };

  let attachment;
  if (platform === 'win32') {
    attachment = new HyperVEnvironmentBootstrap({ directory: path.join(root, 'bootstrap', 'attachment'), invoke, locate: location, connection: baseAccess });
  } else if (platform === 'linux') {
    attachment = new LibvirtEnvironmentBootstrap({ directory: path.join(root, 'bootstrap', 'attachment'), invoke, locate: location, connection: baseAccess });
  } else {
    throw new Error('no bootstrap attachment is available for this host platform');
  }

  const resolvedAccess = async (target) => attachment.connection(target);
  const bridge = await createEnvironmentBridge({ stateDirectory, platform, invoke, access: resolvedAccess });

  const waitForBridge = async (target) => {
    const deadline = Date.now() + 90_000;
    let last = null;
    do {
      try {
        const health = await bridge.health(target);
        if (health.ready) return health;
        last = new Error(health.reason ?? 'exchange endpoint is not ready');
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < deadline);
    throw new Error(`bootstrap exchange endpoint did not become ready: ${last?.message ?? 'unknown failure'}`);
  };

  const prepare = async (target) => {
    const active = (await foundation.listEnvironments()).map((entry) => entry.record.identity);
    await attachment.reconcile(active);
    let current = await foundation.observeEnvironment(target);
    const first = await attachment.prepare(target);
    if (first.cycleRequired) {
      if (running(current.observation?.state)) await foundation.stopEnvironment(target, { force: false, timeoutMs: 60_000 });
      const second = await attachment.prepare(target);
      if (!second.ready || second.cycleRequired) throw new Error('bootstrap preparation still requires a lifecycle cycle');
      current = await foundation.observeEnvironment(target);
    }
    if (!running(current.observation?.state)) {
      if (!stopped(current.observation?.state)) throw new Error('environment state is incompatible with bootstrap activation');
      await foundation.startEnvironment(target);
    }
    await attachment.activate(target);
    await waitForBridge(target);
  };

  const basis = async (target) => {
    const current = await foundation.observeEnvironment(target);
    const selected = await resolvedAccess(target);
    return {
      subject: current.record.identity,
      generation: current.record.generation,
      profile: current.record.profile,
      variant: selected.family,
      source: {
        identity: current.record.source.identity,
        revision: current.record.source.revision,
        digest: current.record.source.digest,
      },
    };
  };

  const exchange = async (target, frame) => {
    const selected = await resolvedAccess(target);
    const program = selected.family === 'windows' ? 'node.exe' : 'node';
    const helper = selected.family === 'windows'
      ? 'C:\\ProgramData\\DevBridge\\environment-bootstrap-agent.mjs'
      : '/usr/local/libexec/devbridge/environment-bootstrap-agent.mjs';
    const outcome = await bridge.execute(target, {
      program,
      arguments: [helper, '--exchange-stdin'],
      directory: { class: 'scratch', path: '.' },
      environment: { DEVBRIDGE_GUEST_TARGET: target },
      input: JSON.stringify(frame),
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1024,
    }, { pollIntervalMs: 500 });
    return parseBootstrapOutput(outcome);
  };

  const cycle = async (target) => {
    const current = await foundation.observeEnvironment(target);
    if (running(current.observation?.state)) await foundation.stopEnvironment(target, { force: false, timeoutMs: 60_000 });
    await foundation.startEnvironment(target);
    await attachment.activate(target);
    await waitForBridge(target);
  };

  const bootstrap = new EnvironmentBootstrap({
    basis,
    plan: async () => ({ revision, requirements, protectedNames, networkRequired: true }),
    prepare,
    exchange,
    cycle,
    settleMs: 90_000,
    pollMs: 1_000,
  });

  return Object.freeze({
    inspect: (target) => bootstrap.inspect(target),
    ensure: (target) => bootstrap.ensure(target),
    verifyContinuity: (target) => bootstrap.verifyContinuity(target),
    connection: (target) => resolvedAccess(target),
    async reconcile() {
      const active = (await foundation.listEnvironments()).map((entry) => entry.record.identity);
      return attachment.reconcile(active);
    },
  });
}
