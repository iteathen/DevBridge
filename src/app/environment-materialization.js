import { normalizeEnvironmentObservation, ENVIRONMENT_OBSERVATION_PROTOCOL } from '../runtime/environment-observation.js';

function assertState(value) {
  const methods = ['listEnvironments', 'ensureEnvironment'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('environment materialization state contract is incomplete');
  return value;
}
function assertRebuildState(value) {
  const methods = ['listEnvironments', 'rebuildEnvironment'];
  if (!value || methods.some((name) => typeof value[name] !== 'function')) throw new TypeError('environment rebuild materialization state contract is incomplete');
  return value;
}
function assertResolver(value, name) {
  if (!value || typeof value.resolve !== 'function') throw new TypeError(`environment materialization ${name} contract is incomplete`);
  return value;
}
function requireRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.declaration) throw new TypeError('environment materialization request is invalid');
  return value;
}
function implementation(record) {
  if (!record || typeof record.identity !== 'string' || !/^env-[a-f0-9]{32}$/u.test(record.identity)) throw new Error('environment materialization returned an invalid implementation generation');
  return record.identity;
}

function systemStorage(raw, storageMatches) {
  if (raw?.storageState === 'absent') return 'absent';
  if (raw?.storageState === 'invalid') return 'invalid';
  if (raw?.storageState === 'present') return storageMatches ? 'present' : 'invalid';
  if (raw?.storage != null) return storageMatches && raw.compatible === true ? 'present' : 'invalid';
  return 'unknown';
}

export function createEnvironmentMaterialization({ state, subject, settings } = {}) {
  const localState = assertState(state);
  const subjectResolver = assertResolver(subject, 'subject');
  const settingsResolver = assertResolver(settings, 'settings');

  const resolve = async (request) => {
    const input = requireRequest(request);
    const localSubject = await subjectResolver.resolve(Object.freeze({
      environmentIdentity: input.environmentIdentity,
      profile: input.declaration.profile,
    }));
    if (typeof localSubject !== 'string' || localSubject.length === 0 || localSubject.includes('\0')) throw new Error('environment materialization subject resolution is invalid');
    return { input, localSubject };
  };

  const observe = async (request) => {
    const { input, localSubject } = await resolve(request);
    const matches = (await localState.listEnvironments()).filter((entry) => entry?.record?.subject === localSubject && entry?.record?.profile === input.declaration.profile);
    if (matches.length === 0) {
      return normalizeEnvironmentObservation({
        protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
        environmentIdentity: input.environmentIdentity,
        declarationRevision: input.declarationRevision,
        implementationGeneration: null,
        materialization: 'none',
        systemStorage: 'unknown',
        attachment: 'unknown',
        enrollment: 'unknown',
        bootstrap: 'unknown',
        guest: 'unknown',
        transition: 'clear',
      });
    }
    if (matches.length !== 1) {
      return normalizeEnvironmentObservation({
        protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
        environmentIdentity: input.environmentIdentity,
        declarationRevision: input.declarationRevision,
        implementationGeneration: null,
        materialization: 'ambiguous',
        systemStorage: 'unknown',
        attachment: 'unknown',
        enrollment: 'unknown',
        bootstrap: 'unknown',
        guest: 'unknown',
        transition: 'ambiguous',
      });
    }
    const selected = matches[0];
    const generation = implementation(selected.record);
    const raw = selected.observation ?? {};
    const owned = raw.owned === true;
    const exists = raw.exists === true;
    if (!owned && exists) {
      return normalizeEnvironmentObservation({
        protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
        environmentIdentity: input.environmentIdentity,
        declarationRevision: input.declarationRevision,
        implementationGeneration: generation,
        materialization: 'ambiguous',
        systemStorage: 'unknown', attachment: 'unknown', enrollment: 'unknown', bootstrap: 'unknown', guest: 'unknown', transition: 'ambiguous',
      });
    }
    const storageMatches = raw.storage?.sourceIdentity === input.declaration.image.identity;
    const storageState = systemStorage(raw, storageMatches);
    const attachment = storageState === 'present' && raw.compatible === true ? 'ready' : raw.exists === true ? 'invalid' : 'unknown';
    return normalizeEnvironmentObservation({
      protocol: ENVIRONMENT_OBSERVATION_PROTOCOL,
      environmentIdentity: input.environmentIdentity,
      declarationRevision: input.declarationRevision,
      implementationGeneration: generation,
      materialization: exists ? 'present' : 'missing',
      systemStorage: storageState,
      attachment,
      enrollment: 'unknown',
      bootstrap: 'unknown',
      guest: 'unknown',
      transition: 'clear',
    });
  };

  return Object.freeze({
    observe,
    async ensure(request) {
      const { input, localSubject } = await resolve(request);
      const localSettings = await settingsResolver.resolve(Object.freeze({
        environmentIdentity: input.environmentIdentity,
        profile: input.declaration.profile,
        resources: input.declaration.resources,
        boot: input.declaration.boot,
      }));
      const result = await localState.ensureEnvironment({
        subject: localSubject,
        profile: input.declaration.profile,
        sourceIdentity: input.declaration.image.identity,
        settings: localSettings,
      });
      const generation = implementation(result?.record);
      return Object.freeze({ ready: result?.observation?.exists === true && result?.observation?.owned === true && result?.observation?.compatible === true, implementationGeneration: generation });
    },
  });
}

export function createEnvironmentRebuildMaterialization({ state, subject, journal } = {}) {
  const localState = assertRebuildState(state);
  const subjectResolver = assertResolver(subject, 'rebuild subject');
  if (!journal || typeof journal.current !== 'function') throw new TypeError('environment rebuild materialization journal contract is incomplete');
  return Object.freeze({
    async ensure(rawRequest) {
      const request = requireRequest(rawRequest);
      const localSubject = await subjectResolver.resolve(Object.freeze({
        environmentIdentity: request.environmentIdentity,
        profile: request.declaration.profile,
      }));
      const matches = (await localState.listEnvironments()).filter((entry) => entry?.record?.subject === localSubject && entry?.record?.profile === request.declaration.profile);
      if (matches.length !== 1) throw new Error('environment rebuild materialization is missing or ambiguous');
      const selected = matches[0];
      if (selected.record?.source?.identity !== request.declaration.image.identity) throw new Error('environment rebuild source no longer matches declaration authority');
      const active = await journal.current(request.environmentIdentity);
      if (!active || active.operation !== 'rebuild' || active.operationId !== request.operationId || active.declarationRevision !== request.declarationRevision) {
        throw new Error('environment rebuild materialization is not bound to the active rebuild lifecycle');
      }
      const previous = active.entries.find((entry) => entry.stage === 'pre-observation')?.implementationGeneration;
      if (typeof previous !== 'string' || !/^env-[a-f0-9]{32}$/u.test(previous)) throw new Error('environment rebuild previous implementation generation is unavailable');
      const result = await localState.rebuildEnvironment(implementation(selected.record), {
        requestId: request.operationId,
        expectedPreviousIdentity: previous,
      });
      const generation = implementation(result?.record);
      if (generation === previous) throw new Error('environment rebuild did not create a new implementation generation');
      return Object.freeze({
        ready: result?.observation?.exists === true && result?.observation?.owned === true && result?.observation?.compatible === true,
        implementationGeneration: generation,
        superseded: result?.superseded == null ? null : Object.freeze({ ...result.superseded }),
      });
    },
  });
}
