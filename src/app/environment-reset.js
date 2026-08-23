function assertPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`environment reset ${name} contract is incomplete`);
  return value;
}
function assertResolver(value) {
  if (!value || typeof value.resolve !== 'function') throw new TypeError('environment reset subject contract is incomplete');
  return value;
}
function requireRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.declaration) throw new TypeError('environment reset request is invalid');
  return value;
}
function implementation(value, name = 'environment reset implementation generation') {
  if (typeof value !== 'string' || !/^env-[a-f0-9]{32}$/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

export function createEnvironmentResetMaterialization({ state, subject, journal } = {}) {
  const localState = assertPort(state, ['listEnvironments', 'replaceEnvironment'], 'materialization state');
  const subjectResolver = assertResolver(subject);
  const localJournal = assertPort(journal, ['current'], 'journal');

  return Object.freeze({
    async ensure(rawRequest) {
      const request = requireRequest(rawRequest);
      const localSubject = await subjectResolver.resolve(Object.freeze({
        environmentIdentity: request.environmentIdentity,
        profile: request.declaration.profile,
      }));
      if (typeof localSubject !== 'string' || localSubject.length === 0 || localSubject.includes('\0')) throw new Error('environment reset subject resolution is invalid');
      const matches = (await localState.listEnvironments()).filter((entry) => entry?.record?.subject === localSubject && entry?.record?.profile === request.declaration.profile);
      if (matches.length !== 1) throw new Error('environment reset materialization is missing or ambiguous');
      const selected = matches[0];
      if (selected.record?.source?.identity !== request.declaration.image.identity) throw new Error('environment reset source no longer matches declaration authority');
      const active = await localJournal.current(request.environmentIdentity);
      if (!active || active.operation !== 'reset' || active.operationId !== request.operationId || active.declarationRevision !== request.declarationRevision) {
        throw new Error('environment reset materialization is not bound to the active reset lifecycle');
      }
      const previous = active.entries.find((entry) => entry.stage === 'pre-observation')?.implementationGeneration;
      implementation(previous, 'environment reset previous implementation generation');
      const result = await localState.replaceEnvironment(implementation(selected.record?.identity), {
        requestId: request.operationId,
        expectedPreviousIdentity: previous,
      });
      const generation = implementation(result?.record?.identity);
      if (generation === previous) throw new Error('environment reset did not create a new implementation generation');
      if (result?.superseded?.identity !== previous || result?.superseded?.cleanup !== 'retained') {
        throw new Error('environment reset replacement did not retain the exact superseded generation');
      }
      return Object.freeze({
        ready: result?.observation?.exists === true && result?.observation?.owned === true && result?.observation?.compatible === true,
        implementationGeneration: generation,
        superseded: Object.freeze({ identity: previous, cleanup: 'retained' }),
      });
    },
  });
}

export function createEnvironmentResetRetirement({ state } = {}) {
  const localState = assertPort(state, ['retireSupersededEnvironment'], 'retirement state');
  return Object.freeze({
    async ensure(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('environment reset retirement request is invalid');
      const current = implementation(input.implementationGeneration, 'environment reset current implementation generation');
      const previous = implementation(input.previousImplementationGeneration, 'environment reset previous implementation generation');
      if (current === previous) throw new Error('environment reset retirement cannot target the current generation');
      const result = await localState.retireSupersededEnvironment(current, { supersededIdentity: previous });
      if (result?.identity !== previous || (result?.removed !== true && result?.absent !== true)) throw new Error('environment reset retirement did not reconcile the exact superseded generation');
      return Object.freeze({ ready: true, identity: previous, removed: result.removed === true, absent: result.absent === true });
    },
  });
}
