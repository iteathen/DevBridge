import path from 'node:path';
import { createConfiguredLifecycleAuthorityClient } from '../runtime/environment-lifecycle-authority-transport.js';
import {
  CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL,
} from './current-principal-observation.js';
import { attemptLinuxCliAuthentication } from './linux-cli-authentication.js';
import { observeLinuxLifecycleAuthorityReadiness } from './linux-lifecycle-authority-readiness.js';
import { observeLocalPrincipal } from './local-principal-observation.js';
import {
  PROTECTED_READINESS_RECONCILIATION_PROTOCOL,
  reconcileProtectedReadiness,
} from './protected-readiness-reconciliation.js';

const PROTOCOL = 'devbridge/setup-lifecycle-authority-v1';
const DIGEST = /^[0-9a-f]{64}$/u;
const REASON = /^[a-z][a-z0-9-]{0,63}$/u;
const LOCAL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;
const MAX_LOCAL_ID = 0xffff_fffe;

function exactObject(value, keys, name, { complete = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) throw new TypeError(`${name} is invalid`);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${name} contains an unknown field`);
    }
  }
  if (complete && Object.keys(descriptors).length !== keys.size) throw new TypeError(`${name} is incomplete`);
  return value;
}

function stateIdentity(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4_096 || /[\0\r\n]/u.test(value)
      || !path.posix.isAbsolute(value) || path.posix.resolve(value) !== value || value === '/') {
    throw new TypeError('setup lifecycle authority state identity is invalid');
  }
  return value;
}

function configuration(value) {
  if (value == null) return null;
  try { exactObject(value, new Set(['inspect', 'reconcile']), 'setup lifecycle authority configuration contract'); }
  catch { throw new TypeError('setup lifecycle authority configuration contract is incomplete'); }
  if (typeof value.inspect !== 'function' || typeof value.reconcile !== 'function') {
    throw new TypeError('setup lifecycle authority configuration contract is incomplete');
  }
  return value;
}

function principalObservation(value) {
  exactObject(value, new Set(['protocol', 'ready', 'principal', 'reason']), 'setup lifecycle authority principal observation');
  if (!Object.isFrozen(value) || value.protocol !== CURRENT_PRINCIPAL_OBSERVATION_PROTOCOL || typeof value.ready !== 'boolean') {
    throw new Error('setup lifecycle authority principal observation is invalid');
  }
  if (!value.ready) {
    if (value.principal !== null || typeof value.reason !== 'string' || !REASON.test(value.reason)) {
      throw new Error('setup lifecycle authority principal observation is invalid');
    }
    return null;
  }
  exactObject(value.principal, new Set(['name', 'identityId', 'primaryCapabilityId']), 'setup lifecycle authority principal');
  if (!Object.isFrozen(value.principal) || value.reason !== null
      || typeof value.principal.name !== 'string' || !LOCAL_NAME.test(value.principal.name)
      || !Number.isSafeInteger(value.principal.identityId) || value.principal.identityId < 1 || value.principal.identityId > MAX_LOCAL_ID
      || !Number.isSafeInteger(value.principal.primaryCapabilityId) || value.principal.primaryCapabilityId < 1
      || value.principal.primaryCapabilityId > MAX_LOCAL_ID) {
    throw new Error('setup lifecycle authority principal observation is invalid');
  }
  return value.principal;
}

function readiness(value) {
  exactObject(value, new Set(['protocol', 'ready', 'attempted', 'generation', 'reason']), 'setup lifecycle authority readiness');
  if (!Object.isFrozen(value) || value.protocol !== PROTECTED_READINESS_RECONCILIATION_PROTOCOL || typeof value.ready !== 'boolean'
      || typeof value.attempted !== 'boolean' || (value.generation != null && (typeof value.generation !== 'string' || !DIGEST.test(value.generation)))) {
    throw new Error('setup lifecycle authority readiness is invalid');
  }
  if (value.ready ? value.reason !== null || value.generation == null : typeof value.reason !== 'string' || !REASON.test(value.reason)) {
    throw new Error('setup lifecycle authority readiness is invalid');
  }
  return value;
}

function configurationResult(value, name, { changeAllowed = true } = {}) {
  exactObject(value, new Set(['ready', 'changed', 'blocker']), name);
  if (typeof value.ready !== 'boolean' || typeof value.changed !== 'boolean'
      || (!changeAllowed && value.changed)
      || (value.ready ? value.blocker !== null : typeof value.blocker !== 'string')) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function result({ ready, changed = false, blocker = null, service = 'unavailable', protectedState = 'unknown' }) {
  return Object.freeze({ protocol: PROTOCOL, ready, blocker, changed, service, protectedState });
}

function unavailable(blocker, overrides = {}) {
  return result({ ready: false, blocker, ...overrides });
}

async function reconcileConfiguration(selected, { stateIdentity: identity, createClient }) {
  if (selected == null) return Object.freeze({ ready: true, changed: false });
  let inspected;
  try {
    const client = createClient({ stateIdentity: identity });
    inspected = configurationResult(
      await selected.inspect({ client }),
      'setup lifecycle authority configuration observation',
      { changeAllowed: false },
    );
  } catch {
    return Object.freeze({ ready: false, changed: false, reason: 'observation-unavailable' });
  }
  if (inspected.ready) return Object.freeze({ ready: true, changed: inspected.changed });

  let reconciled;
  try {
    reconciled = configurationResult(await selected.reconcile(), 'setup lifecycle authority configuration reconciliation');
  } catch {
    return Object.freeze({ ready: false, changed: false, reason: 'reconciliation-failed' });
  }
  if (!reconciled.ready) return Object.freeze({ ready: false, changed: reconciled.changed, reason: 'reconciliation-incomplete' });

  try {
    const client = createClient({ stateIdentity: identity });
    inspected = configurationResult(
      await selected.inspect({ client }),
      'setup lifecycle authority configuration verification',
      { changeAllowed: false },
    );
  } catch {
    return Object.freeze({ ready: false, changed: reconciled.changed, reason: 'verification-unavailable' });
  }
  if (!inspected.ready) return Object.freeze({ ready: false, changed: reconciled.changed, reason: 'verification-incomplete' });
  return Object.freeze({ ready: true, changed: reconciled.changed || inspected.changed });
}

export async function reconcileLinuxSetupLifecycleAuthority(value = {}, providedPorts = {}) {
  exactObject(value, new Set(['stateIdentity', 'configuration']), 'setup lifecycle authority request');
  exactObject(
    providedPorts,
    new Set(['observePrincipal', 'observe', 'reconcile', 'attempt', 'createClient']),
    'setup lifecycle authority ports',
    { complete: false },
  );
  const request = Object.freeze({
    stateIdentity: stateIdentity(value.stateIdentity),
    configuration: configuration(value.configuration),
  });
  const ports = Object.freeze({
    observePrincipal: providedPorts.observePrincipal ?? observeLocalPrincipal,
    observe: providedPorts.observe ?? observeLinuxLifecycleAuthorityReadiness,
    reconcile: providedPorts.reconcile ?? reconcileProtectedReadiness,
    attempt: providedPorts.attempt ?? attemptLinuxCliAuthentication,
    createClient: providedPorts.createClient ?? (({ stateIdentity: identity }) => createConfiguredLifecycleAuthorityClient({
      stateDirectory: identity,
      platform: 'linux',
      connectTimeoutMs: 3_000,
    })),
  });
  if (Object.values(ports).some((port) => typeof port !== 'function')) {
    throw new TypeError('setup lifecycle authority ports are invalid');
  }

  let principal;
  try { principal = principalObservation(await ports.observePrincipal()); }
  catch { return unavailable('Current local principal could not be verified for protected lifecycle setup.'); }
  if (principal == null) return unavailable('Current local principal could not be verified for protected lifecycle setup.');

  let observed;
  try {
    observed = readiness(await ports.reconcile({
      observe: () => ports.observe({ stateIdentity: request.stateIdentity, principal: principal.name }),
      attempt: (subject) => ports.attempt({ subject }),
    }));
  } catch {
    return unavailable('Protected lifecycle authority readiness could not be verified.');
  }
  if (!observed.ready) {
    return unavailable(observed.attempted
      ? 'Protected lifecycle authority remains unavailable after one local authentication attempt; resolve the local boundary and re-run devbridge setup.'
      : 'Protected lifecycle authority is not ready; resolve the local boundary and re-run devbridge setup.');
  }

  const configured = await reconcileConfiguration(request.configuration, {
    stateIdentity: request.stateIdentity,
    createClient: ports.createClient,
  });
  if (!configured.ready) {
    return unavailable('Accepted environment profile configuration did not verify through protected authority.', {
      changed: configured.changed,
      service: 'ready',
      protectedState: 'ready',
    });
  }
  return result({
    ready: true,
    changed: configured.changed,
    service: 'ready',
    protectedState: 'ready',
  });
}

export { PROTOCOL as SETUP_LIFECYCLE_AUTHORITY_PROTOCOL };
