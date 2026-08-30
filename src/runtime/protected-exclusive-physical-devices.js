import { ExclusivePhysicalDevices } from './exclusive-physical-devices.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const OBSERVATION_KEYS = new Set(['subject', 'deviceGeneration', 'state', 'rootSafe', 'owner', 'assignmentGeneration', 'reason']);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function requireId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeEnvironment(raw, name = 'protected physical device environment') {
  const value = requireObject(raw, name);
  onlyKeys(value, new Set(['identity', 'generation']), name);
  return Object.freeze({
    identity: requireId(value.identity, `${name} identity`),
    generation: requireId(value.generation, `${name} generation`),
  });
}

function sameEnvironment(left, right) {
  return left?.identity === right?.identity && left?.generation === right?.generation;
}

function environmentKey(environment) {
  return `${environment.identity}\0${environment.generation}`;
}

function normalizeInventory(raw, expectedSubject) {
  const value = requireObject(raw, 'protected physical device inventory');
  onlyKeys(value, new Set(['subject', 'generation', 'eligible', 'critical', 'capabilities', 'reason']), 'protected physical device inventory');
  if (value.subject !== expectedSubject) throw new Error('protected physical device inventory subject changed');
  if (typeof value.eligible !== 'boolean' || typeof value.critical !== 'boolean') throw new TypeError('protected physical device eligibility is invalid');
  return Object.freeze({
    subject: requireId(value.subject, 'protected physical device subject'),
    generation: requireId(value.generation, 'protected physical device generation'),
    eligible: value.eligible,
    critical: value.critical,
    reason: value.reason == null ? null : String(value.reason),
  });
}

function normalizeAdmission(raw, expectedEnvironment) {
  const value = requireObject(raw, 'protected physical device environment admission');
  onlyKeys(value, new Set(['identity', 'generation', 'admitted', 'reason']), 'protected physical device environment admission');
  const environment = normalizeEnvironment({ identity: value.identity, generation: value.generation });
  if (!sameEnvironment(environment, expectedEnvironment)) throw new Error('protected physical device environment generation changed');
  if (typeof value.admitted !== 'boolean') throw new TypeError('protected physical device environment admission is invalid');
  return Object.freeze({ ...environment, admitted: value.admitted, reason: value.reason == null ? null : String(value.reason) });
}

function normalizePreparation(raw, expectedEnvironment) {
  const value = requireObject(raw, 'protected physical device preparation');
  onlyKeys(value, new Set(['identity', 'generation', 'ready', 'preparationGeneration', 'reason']), 'protected physical device preparation');
  const environment = normalizeEnvironment({ identity: value.identity, generation: value.generation });
  if (!sameEnvironment(environment, expectedEnvironment)) throw new Error('protected physical device preparation environment changed');
  if (typeof value.ready !== 'boolean') throw new TypeError('protected physical device preparation readiness is invalid');
  return Object.freeze({
    ...environment,
    ready: value.ready,
    preparationGeneration: requireId(value.preparationGeneration, 'protected physical device preparation generation'),
    reason: value.reason == null ? null : String(value.reason),
  });
}

function normalizeObservation(raw, expectedSubject, expectedGeneration) {
  const value = requireObject(raw, 'protected physical device provider observation');
  onlyKeys(value, OBSERVATION_KEYS, 'protected physical device provider observation');
  if (value.subject !== expectedSubject) throw new Error('protected physical device provider subject changed');
  if (value.deviceGeneration !== expectedGeneration) throw new Error('protected physical device provider generation changed');
  if (!['available', 'owned', 'unknown'].includes(value.state)) throw new TypeError('protected physical device provider state is invalid');
  if (typeof value.rootSafe !== 'boolean') throw new TypeError('protected physical device provider root-safe state is invalid');
  const owner = value.owner == null ? null : normalizeEnvironment(value.owner, 'protected physical device provider owner');
  const assignmentGeneration = value.assignmentGeneration == null
    ? null
    : requireId(value.assignmentGeneration, 'protected physical device assignment generation');
  if (value.state === 'available' && (!value.rootSafe || owner != null)) throw new Error('protected physical device provider availability is not root-safe');
  if (value.state === 'owned' && (value.rootSafe || owner == null)) throw new Error('protected physical device provider ownership is incomplete');
  if (value.state === 'unknown' && value.rootSafe) throw new Error('unknown protected physical device provider state cannot be root-safe');
  return Object.freeze({
    subject: expectedSubject,
    deviceGeneration: expectedGeneration,
    state: value.state,
    rootSafe: value.rootSafe,
    owner,
    assignmentGeneration,
    reason: value.reason == null ? null : String(value.reason),
  });
}

function assertPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

export function createProtectedExclusivePhysicalDevices({
  directory,
  inventory,
  environments,
  assignment,
  preparation,
  guestLifecycle,
  qualification,
} = {}) {
  const localInventory = assertPort(inventory, ['resolve'], 'protected physical device inventory');
  const localEnvironments = assertPort(environments, ['observe'], 'protected physical device environment admission');
  const localAssignment = assertPort(assignment, ['observe', 'claim', 'release'], 'protected physical device assignment');
  const localPreparation = assertPort(preparation, ['observe'], 'protected physical device preparation');
  const lastPreparedGeneration = new Map();

  const trackedPreparation = Object.freeze({
    async observe(rawEnvironment) {
      const environment = normalizeEnvironment(rawEnvironment);
      const observed = normalizePreparation(await localPreparation.observe(environment), environment);
      lastPreparedGeneration.set(environmentKey(environment), observed.preparationGeneration);
      return structuredClone(observed);
    },
  });

  const guardedAssignment = Object.freeze({
    async observe(subject) {
      const inventoryNow = normalizeInventory(await localInventory.resolve(subject), subject);
      return structuredClone(await normalizeObservation(
        await localAssignment.observe(subject),
        subject,
        inventoryNow.generation,
      ));
    },

    async claim(raw) {
      const request = requireObject(raw, 'protected physical device claim effect');
      onlyKeys(request, new Set(['subject', 'deviceGeneration', 'environment']), 'protected physical device claim effect');
      const subject = requireId(request.subject, 'protected physical device claim subject');
      const deviceGeneration = requireId(request.deviceGeneration, 'protected physical device claim generation');
      const environment = normalizeEnvironment(request.environment);

      const inventoryNow = normalizeInventory(await localInventory.resolve(subject), subject);
      if (inventoryNow.generation !== deviceGeneration) throw new Error('protected physical device generation changed immediately before claim effect');
      if (inventoryNow.critical) throw new Error(inventoryNow.reason ?? 'protected physical device became host-critical before claim effect');
      if (!inventoryNow.eligible) throw new Error(inventoryNow.reason ?? 'protected physical device is no longer locally approved before claim effect');

      const admission = normalizeAdmission(await localEnvironments.observe(environment), environment);
      if (!admission.admitted) throw new Error(admission.reason ?? 'protected physical device environment is no longer admitted before claim effect');

      const expectedPreparationGeneration = lastPreparedGeneration.get(environmentKey(environment));
      if (expectedPreparationGeneration == null) throw new Error('protected physical device preparation was not validated before claim effect');
      const preparationNow = normalizePreparation(await localPreparation.observe(environment), environment);
      if (!preparationNow.ready) throw new Error(preparationNow.reason ?? 'protected physical device preparation is no longer ready before claim effect');
      if (preparationNow.preparationGeneration !== expectedPreparationGeneration) {
        throw new Error('protected physical device preparation generation changed immediately before claim effect');
      }

      const observed = normalizeObservation(await localAssignment.observe(subject), subject, deviceGeneration);
      if (observed.state !== 'available' || !observed.rootSafe) {
        throw new Error(observed.reason ?? 'protected physical device is no longer root-safe immediately before claim effect');
      }

      return localAssignment.claim({
        subject,
        deviceGeneration,
        environment: structuredClone(environment),
      });
    },

    async release(raw) {
      const request = requireObject(raw, 'protected physical device release effect');
      onlyKeys(request, new Set(['subject', 'deviceGeneration', 'environment', 'assignmentGeneration']), 'protected physical device release effect');
      const subject = requireId(request.subject, 'protected physical device release subject');
      const deviceGeneration = requireId(request.deviceGeneration, 'protected physical device release generation');
      const environment = normalizeEnvironment(request.environment);
      const assignmentGeneration = requireId(request.assignmentGeneration, 'protected physical device release assignment generation');

      const inventoryNow = normalizeInventory(await localInventory.resolve(subject), subject);
      if (inventoryNow.generation !== deviceGeneration) throw new Error('protected physical device generation changed immediately before release effect');

      const observed = normalizeObservation(await localAssignment.observe(subject), subject, deviceGeneration);
      if (observed.state !== 'owned' || !sameEnvironment(observed.owner, environment) || observed.assignmentGeneration !== assignmentGeneration) {
        throw new Error('protected physical device release no longer matches the exact provider owner');
      }

      return localAssignment.release({
        subject,
        deviceGeneration,
        environment: structuredClone(environment),
        assignmentGeneration,
      });
    },
  });

  return new ExclusivePhysicalDevices({
    directory,
    inventory: localInventory,
    environments: localEnvironments,
    assignment: guardedAssignment,
    preparation: trackedPreparation,
    guestLifecycle,
    qualification,
  });
}
