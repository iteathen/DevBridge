const GENERATION = /^[0-9a-f]{64}$/u;
const EFFECTS = new Set(['stage', 'quiesce', 'promote', 'start', 'restore']);
const MAX_RETAINED = 8;
const MAX_REASON = 1024;

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function generation(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !GENERATION.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function uniqueGenerations(value, name, maximum = MAX_RETAINED) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${name} is invalid`);
  const selected = value.map((entry) => generation(entry, `${name} entry`));
  if (new Set(selected).size !== selected.length) throw new TypeError(`${name} is ambiguous`);
  return Object.freeze(selected);
}

function stateRecord(value) {
  if (value == null) return null;
  exactKeys(value, new Set(['bound', 'activeGeneration', 'stagedGeneration', 'retainedGenerations']), 'Linux refresh durable state');
  if (typeof value.bound !== 'boolean') throw new TypeError('Linux refresh durable state binding is invalid');
  const activeGeneration = generation(value.activeGeneration, 'Linux refresh active generation', { nullable: true });
  const stagedGeneration = generation(value.stagedGeneration, 'Linux refresh staged generation', { nullable: true });
  const retainedGenerations = uniqueGenerations(value.retainedGenerations, 'Linux refresh retained generations');
  if (activeGeneration != null && (activeGeneration === stagedGeneration || retainedGenerations.includes(activeGeneration))) {
    throw new TypeError('Linux refresh active generation aliases another state');
  }
  if (stagedGeneration != null && retainedGenerations.includes(stagedGeneration)) {
    throw new TypeError('Linux refresh staged generation aliases retained state');
  }
  return Object.freeze({ bound: value.bound, activeGeneration, stagedGeneration, retainedGenerations });
}

function transitionRecord(value, candidateGeneration) {
  if (value == null) return null;
  exactKeys(value, new Set(['effect', 'targetGeneration', 'candidateGeneration', 'previousGeneration', 'status']), 'Linux refresh pending transition');
  if (!EFFECTS.has(value.effect) || !['planned', 'attempted'].includes(value.status)) {
    throw new TypeError('Linux refresh pending transition is invalid');
  }
  const normalized = Object.freeze({
    effect: value.effect,
    targetGeneration: generation(value.targetGeneration, 'Linux refresh pending transition target'),
    candidateGeneration: generation(value.candidateGeneration, 'Linux refresh pending transition candidate'),
    previousGeneration: generation(value.previousGeneration, 'Linux refresh pending transition previous generation', { nullable: true }),
    status: value.status,
  });
  if (normalized.candidateGeneration !== candidateGeneration) {
    throw new TypeError('Linux refresh pending transition does not match the exact candidate');
  }
  return normalized;
}

function requestGeneration(value, name) {
  exactKeys(value, new Set(['generation']), name);
  return Object.freeze({ generation: generation(value.generation, `${name} generation`) });
}

function promotionRequest(value) {
  exactKeys(value, new Set(['generation', 'previousGeneration']), 'Linux refresh promotion request');
  return Object.freeze({
    generation: generation(value.generation, 'Linux refresh promotion generation'),
    previousGeneration: generation(value.previousGeneration, 'Linux refresh promotion previous generation', { nullable: true }),
  });
}

function restorationRequest(value) {
  exactKeys(value, new Set(['generation', 'failedGeneration']), 'Linux refresh restoration request');
  return Object.freeze({
    generation: generation(value.generation, 'Linux refresh restoration generation'),
    failedGeneration: generation(value.failedGeneration, 'Linux refresh restoration failed generation'),
  });
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizePorts(value) {
  exactKeys(value, new Set(['journal', 'transition', 'state', 'subjects', 'preparation', 'definition', 'activity', 'probe']), 'Linux refresh ports');
  exactKeys(value.journal, new Set(['load', 'save']), 'Linux refresh journal ports');
  exactKeys(value.transition, new Set(['load']), 'Linux refresh transition ports');
  exactKeys(value.state, new Set(['load', 'save']), 'Linux refresh state ports');
  exactKeys(value.subjects, new Set(['observe', 'stage', 'verify']), 'Linux refresh subject ports');
  exactKeys(value.preparation, new Set(['ensure']), 'Linux refresh preparation ports');
  exactKeys(value.definition, new Set(['ensure']), 'Linux refresh definition ports');
  exactKeys(value.activity, new Set(['inspect', 'quiesce', 'activate']), 'Linux refresh activity ports');
  for (const [name, port] of Object.entries({
    journalLoad: value.journal.load,
    journalSave: value.journal.save,
    transitionLoad: value.transition.load,
    stateLoad: value.state.load,
    stateSave: value.state.save,
    subjectsObserve: value.subjects.observe,
    subjectsStage: value.subjects.stage,
    subjectsVerify: value.subjects.verify,
    preparationEnsure: value.preparation.ensure,
    definitionEnsure: value.definition.ensure,
    activityInspect: value.activity.inspect,
    activityQuiesce: value.activity.quiesce,
    activityActivate: value.activity.activate,
    probe: value.probe,
  })) requireFunction(port, `Linux refresh ${name} port`);
  return value;
}

function declared(state) {
  if (state == null) return Object.freeze([]);
  return Object.freeze([
    state.activeGeneration,
    state.stagedGeneration,
    ...state.retainedGenerations,
  ].filter((entry) => entry != null));
}

function allowedGenerations(candidateGeneration, state, transition) {
  const values = new Set([candidateGeneration, ...declared(state)]);
  if (transition != null) {
    values.add(transition.targetGeneration);
    values.add(transition.candidateGeneration);
    if (transition.previousGeneration != null) values.add(transition.previousGeneration);
  }
  return Object.freeze([...values].sort());
}

function subjectObservation(value, allowed, required) {
  exactKeys(value, new Set(['presentGenerations', 'exact']), 'Linux refresh subject observation');
  if (typeof value.exact !== 'boolean') throw new TypeError('Linux refresh subject observation exactness is invalid');
  const present = uniqueGenerations(value.presentGenerations, 'Linux refresh present generations', MAX_RETAINED + 3);
  if (present.some((entry) => !allowed.includes(entry))) throw new TypeError('Linux refresh subject observation contains an undeclared generation');
  const complete = required.every((entry) => present.includes(entry));
  return Object.freeze({ exact: value.exact, presentGenerations: present, complete });
}

function activityObservation(value, allowed) {
  exactKeys(value, new Set(['exists', 'running', 'configuredGeneration', 'processGeneration']), 'Linux refresh activity observation');
  if (typeof value.exists !== 'boolean' || typeof value.running !== 'boolean') {
    throw new TypeError('Linux refresh activity observation is invalid');
  }
  const configuredGeneration = generation(value.configuredGeneration, 'Linux refresh configured generation', { nullable: true });
  const processGeneration = generation(value.processGeneration, 'Linux refresh process generation', { nullable: true });
  if (!value.exists) {
    if (value.running || configuredGeneration != null || processGeneration != null) throw new TypeError('Linux refresh absent activity contains state');
  } else if (configuredGeneration == null || !allowed.includes(configuredGeneration)) {
    throw new TypeError('Linux refresh configured generation is undeclared');
  }
  if (!value.running && processGeneration != null) throw new TypeError('Linux refresh stopped activity contains a process generation');
  if (value.running && (processGeneration == null || processGeneration !== configuredGeneration || !allowed.includes(processGeneration))) {
    throw new TypeError('Linux refresh running activity does not match its configuration');
  }
  return Object.freeze({ exists: value.exists, running: value.running, configuredGeneration, processGeneration });
}

function stableActivity(state, activity) {
  if (state.activeGeneration == null) return !activity.exists;
  return activity.exists && activity.configuredGeneration === state.activeGeneration;
}

function admittedTransition(state, activity, transition) {
  if (transition == null || activity.running) return false;
  if (transition.effect === 'promote') {
    return transition.targetGeneration === transition.candidateGeneration
      && state.activeGeneration === transition.previousGeneration
      && state.stagedGeneration === transition.targetGeneration
      && activity.exists
      && activity.configuredGeneration === transition.targetGeneration;
  }
  if (transition.effect === 'restore') {
    return transition.previousGeneration === transition.targetGeneration
      && state.activeGeneration === transition.candidateGeneration
      && state.retainedGenerations.includes(transition.targetGeneration)
      && activity.exists
      && activity.configuredGeneration === transition.targetGeneration;
  }
  return false;
}

function effectEvidence(value, expected, name) {
  exactKeys(value, new Set(['generation', 'ready']), name);
  if (generation(value.generation, `${name} generation`) !== expected || value.ready !== true) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function verificationEvidence(value, expected) {
  exactKeys(value, new Set(['generation', 'verified']), 'Linux refresh subject verification');
  if (generation(value.generation, 'Linux refresh verified generation') !== expected || typeof value.verified !== 'boolean') {
    throw new Error('Linux refresh subject verification is invalid');
  }
  return Object.freeze({ generation: expected, verified: value.verified });
}

function healthEvidence(value, expected) {
  exactKeys(value, new Set(['generation', 'ready', 'reason']), 'Linux refresh probe evidence');
  if (generation(value.generation, 'Linux refresh probe generation') !== expected || typeof value.ready !== 'boolean') {
    throw new Error('Linux refresh probe evidence is invalid');
  }
  if (value.reason != null && (typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > MAX_REASON || /[\r\n]/u.test(value.reason))) {
    throw new Error('Linux refresh probe reason is invalid');
  }
  return Object.freeze({ generation: expected, ready: value.ready, reason: value.reason ?? null });
}

function sameState(left, right) {
  return left.bound === right.bound
    && left.activeGeneration === right.activeGeneration
    && left.stagedGeneration === right.stagedGeneration
    && left.retainedGenerations.length === right.retainedGenerations.length
    && left.retainedGenerations.every((entry, index) => entry === right.retainedGenerations[index]);
}

async function saveState(ports, value) {
  const target = stateRecord(value);
  const saved = stateRecord(await ports.state.save(target));
  if (saved == null || !sameState(saved, target)) throw new Error('Linux refresh durable state save is not exact');
  return saved;
}

async function inspectLocal(ports, candidateGeneration) {
  const state = stateRecord(await ports.state.load());
  const transition = transitionRecord(await ports.transition.load(), candidateGeneration);
  const allowed = allowedGenerations(candidateGeneration, state, transition);
  const [subjects, activity] = await Promise.all([
    ports.subjects.observe(Object.freeze({ generations: allowed })).then((value) => subjectObservation(value, allowed, declared(state))),
    ports.activity.inspect(Object.freeze({ generations: allowed })).then((value) => activityObservation(value, allowed)),
  ]);
  return Object.freeze({ state, transition, allowed, subjects, activity });
}

async function inspectForState(ports, candidateGeneration, state) {
  const transition = transitionRecord(await ports.transition.load(), candidateGeneration);
  const allowed = allowedGenerations(candidateGeneration, state, transition);
  const [subjects, activity] = await Promise.all([
    ports.subjects.observe(Object.freeze({ generations: allowed })).then((value) => subjectObservation(value, allowed, declared(state))),
    ports.activity.inspect(Object.freeze({ generations: allowed })).then((value) => activityObservation(value, allowed)),
  ]);
  if (!(subjects.exact && subjects.complete)) throw new Error('Linux refresh declared generation state is not exact');
  return Object.freeze({ transition, allowed, subjects, activity });
}

async function verifySubject(ports, selected) {
  return verificationEvidence(await ports.subjects.verify(Object.freeze({ generation: selected })), selected);
}

function retainedAfterPromotion(state, previousGeneration) {
  const retained = [...state.retainedGenerations];
  if (previousGeneration != null && !retained.includes(previousGeneration)) retained.push(previousGeneration);
  if (retained.length > MAX_RETAINED) throw new Error('Linux refresh retained generation capacity is exhausted');
  return Object.freeze(retained);
}

function retainedAfterRestoration(state, generationValue, failedGeneration) {
  const retained = state.retainedGenerations.filter((entry) => entry !== generationValue);
  if (!retained.includes(failedGeneration)) retained.push(failedGeneration);
  if (retained.length > MAX_RETAINED) throw new Error('Linux refresh retained generation capacity is exhausted');
  return Object.freeze(retained);
}

export function createLinuxLifecycleAuthorityRefreshMechanics(value = {}) {
  exactKeys(value, new Set(['candidateGeneration', 'ports']), 'Linux refresh mechanics request');
  const candidateGeneration = generation(value.candidateGeneration, 'Linux refresh candidate generation');
  const ports = normalizePorts(value.ports);

  return Object.freeze({
    journal: ports.journal,

    async observeInstallation() {
      const observed = await inspectLocal(ports, candidateGeneration);
      if (observed.state == null) {
        const absent = observed.subjects.exact && observed.subjects.presentGenerations.length === 0 && !observed.activity.exists;
        return Object.freeze({
          ownership: absent ? 'absent' : 'ambiguous',
          activeGeneration: null,
          stagedGeneration: null,
          running: false,
          retainedGenerations: Object.freeze([]),
        });
      }
      const exact = observed.state.bound
        && observed.subjects.exact
        && observed.subjects.complete
        && (stableActivity(observed.state, observed.activity)
          || admittedTransition(observed.state, observed.activity, observed.transition));
      const running = exact
        && stableActivity(observed.state, observed.activity)
        && observed.state.activeGeneration != null
        && observed.activity.running;
      return Object.freeze({
        ownership: exact ? 'owned' : 'ambiguous',
        activeGeneration: observed.state.activeGeneration,
        stagedGeneration: observed.state.stagedGeneration,
        running,
        retainedGenerations: observed.state.retainedGenerations,
      });
    },

    async stageGeneration(value) {
      const request = requestGeneration(value, 'Linux refresh stage request');
      if (request.generation !== candidateGeneration) throw new Error('Linux refresh can stage only the exact candidate');
      const state = stateRecord(await ports.state.load());
      if (state == null || !state.bound) throw new Error('Linux refresh stage requires bound durable state');
      if (state.activeGeneration === request.generation || state.retainedGenerations.includes(request.generation)) {
        throw new Error('Linux refresh candidate aliases durable generation state');
      }
      if (state.activeGeneration != null && state.retainedGenerations.length >= MAX_RETAINED) {
        throw new Error('Linux refresh retained generation capacity is exhausted');
      }
      if (state.stagedGeneration != null && state.stagedGeneration !== request.generation) {
        throw new Error('Linux refresh another generation is already staged');
      }
      if (state.stagedGeneration === request.generation) {
        if (!(await verifySubject(ports, request.generation)).verified) throw new Error('Linux refresh staged candidate is not exact');
        return;
      }
      effectEvidence(await ports.subjects.stage(request), request.generation, 'Linux refresh stage evidence');
      if (!(await verifySubject(ports, request.generation)).verified) throw new Error('Linux refresh staged candidate verification failed');
      await saveState(ports, { ...state, stagedGeneration: request.generation });
    },

    async verifyGeneration(value) {
      const request = requestGeneration(value, 'Linux refresh verify request');
      return await verifySubject(ports, request.generation);
    },

    async quiesceGeneration(value) {
      const request = requestGeneration(value, 'Linux refresh quiesce request');
      const state = stateRecord(await ports.state.load());
      if (state == null || !state.bound || state.activeGeneration !== request.generation) {
        throw new Error('Linux refresh quiesce subject is not the durable active generation');
      }
      let observed = await inspectForState(ports, candidateGeneration, state);
      if (!stableActivity(state, observed.activity)) throw new Error('Linux refresh active configuration is not exact before quiesce');
      if (!observed.activity.running) return;
      effectEvidence(await ports.activity.quiesce(request), request.generation, 'Linux refresh quiesce evidence');
      observed = await inspectForState(ports, candidateGeneration, state);
      if (!stableActivity(state, observed.activity) || observed.activity.running) throw new Error('Linux refresh quiesce is not observable');
    },

    async promoteGeneration(value) {
      const request = promotionRequest(value);
      if (request.generation !== candidateGeneration) throw new Error('Linux refresh can promote only the exact candidate');
      let state = stateRecord(await ports.state.load());
      if (state == null || !state.bound) throw new Error('Linux refresh promotion requires bound durable state');
      if (state.activeGeneration === request.generation && state.stagedGeneration == null) {
        const observed = await inspectForState(ports, candidateGeneration, state);
        if (!stableActivity(state, observed.activity) || observed.activity.running) throw new Error('Linux refresh completed promotion is not exact');
        return;
      }
      if (state.activeGeneration !== request.previousGeneration || state.stagedGeneration !== request.generation) {
        throw new Error('Linux refresh promotion durable state changed');
      }
      const retainedGenerations = retainedAfterPromotion(state, request.previousGeneration);
      if (!(await verifySubject(ports, request.generation)).verified) throw new Error('Linux refresh promotion subject is not exact');
      let observed = await inspectForState(ports, candidateGeneration, state);
      const allowedConfiguration = request.previousGeneration == null
        ? !observed.activity.exists || observed.activity.configuredGeneration === request.generation
        : observed.activity.exists && [request.previousGeneration, request.generation].includes(observed.activity.configuredGeneration);
      if (!allowedConfiguration || observed.activity.running) throw new Error('Linux refresh promotion activity is not quiesced and admitted');
      effectEvidence(await ports.preparation.ensure(Object.freeze({ generation: request.generation })), request.generation, 'Linux refresh preparation evidence');
      effectEvidence(await ports.definition.ensure(Object.freeze({
        generation: request.generation,
        acceptedGenerations: Object.freeze(request.previousGeneration == null ? [] : [request.previousGeneration]),
      })), request.generation, 'Linux refresh definition evidence');
      observed = await inspectForState(ports, candidateGeneration, state);
      if (!observed.activity.exists || observed.activity.running || observed.activity.configuredGeneration !== request.generation) {
        throw new Error('Linux refresh promoted definition is not observable');
      }
      state = await saveState(ports, {
        ...state,
        activeGeneration: request.generation,
        stagedGeneration: null,
        retainedGenerations,
      });
      if (state.activeGeneration !== request.generation) throw new Error('Linux refresh promotion state is not exact');
    },

    async startGeneration(value) {
      const request = requestGeneration(value, 'Linux refresh start request');
      const state = stateRecord(await ports.state.load());
      if (state == null || !state.bound || state.activeGeneration !== request.generation) {
        throw new Error('Linux refresh start subject is not the durable active generation');
      }
      if (!(await verifySubject(ports, request.generation)).verified) throw new Error('Linux refresh start subject is not exact');
      let observed = await inspectForState(ports, candidateGeneration, state);
      if (!stableActivity(state, observed.activity)) throw new Error('Linux refresh start configuration is not exact');
      if (observed.activity.running) return;
      effectEvidence(await ports.activity.activate(request), request.generation, 'Linux refresh activation evidence');
      observed = await inspectForState(ports, candidateGeneration, state);
      if (!stableActivity(state, observed.activity) || !observed.activity.running
          || observed.activity.processGeneration !== request.generation) {
        throw new Error('Linux refresh activation is not observable');
      }
    },

    async probeGeneration(value) {
      const request = requestGeneration(value, 'Linux refresh health request');
      const verified = await verifySubject(ports, request.generation);
      if (!verified.verified) return Object.freeze({ generation: request.generation, ready: false, reason: 'generation verification failed' });
      const state = stateRecord(await ports.state.load());
      if (state == null || !state.bound || state.activeGeneration !== request.generation) {
        return Object.freeze({ generation: request.generation, ready: false, reason: 'durable active generation does not match' });
      }
      const observed = await inspectForState(ports, candidateGeneration, state);
      if (!stableActivity(state, observed.activity) || !observed.activity.running
          || observed.activity.processGeneration !== request.generation) {
        return Object.freeze({ generation: request.generation, ready: false, reason: 'configured or running generation does not match' });
      }
      return healthEvidence(await ports.probe(request), request.generation);
    },

    async restoreGeneration(value) {
      const request = restorationRequest(value);
      let state = stateRecord(await ports.state.load());
      if (state == null || !state.bound) throw new Error('Linux refresh restoration requires bound durable state');
      if (state.activeGeneration === request.generation && state.retainedGenerations.includes(request.failedGeneration)) {
        const observed = await inspectForState(ports, candidateGeneration, state);
        if (!stableActivity(state, observed.activity) || observed.activity.running) throw new Error('Linux refresh completed restoration is not exact');
        return;
      }
      if (state.activeGeneration !== request.failedGeneration || !state.retainedGenerations.includes(request.generation)) {
        throw new Error('Linux refresh restoration durable state changed');
      }
      const retainedGenerations = retainedAfterRestoration(state, request.generation, request.failedGeneration);
      if (!(await verifySubject(ports, request.generation)).verified) throw new Error('Linux refresh restoration subject is not exact');
      let observed = await inspectForState(ports, candidateGeneration, state);
      if (!observed.activity.exists || ![request.failedGeneration, request.generation].includes(observed.activity.configuredGeneration)) {
        throw new Error('Linux refresh restoration configuration is not admitted');
      }
      if (observed.activity.running) {
        if (observed.activity.configuredGeneration !== request.failedGeneration
            || observed.activity.processGeneration !== request.failedGeneration) {
          throw new Error('Linux refresh restoration running subject is ambiguous');
        }
        effectEvidence(await ports.activity.quiesce(Object.freeze({ generation: request.failedGeneration })), request.failedGeneration, 'Linux refresh restoration quiesce evidence');
        observed = await inspectForState(ports, candidateGeneration, state);
        if (observed.activity.running) throw new Error('Linux refresh failed generation did not quiesce');
      }
      effectEvidence(await ports.preparation.ensure(Object.freeze({ generation: request.generation })), request.generation, 'Linux refresh recovery preparation evidence');
      effectEvidence(await ports.definition.ensure(Object.freeze({
        generation: request.generation,
        acceptedGenerations: Object.freeze([request.failedGeneration]),
      })), request.generation, 'Linux refresh recovery definition evidence');
      observed = await inspectForState(ports, candidateGeneration, state);
      if (!observed.activity.exists || observed.activity.running || observed.activity.configuredGeneration !== request.generation) {
        throw new Error('Linux refresh restored definition is not observable');
      }
      state = await saveState(ports, {
        ...state,
        activeGeneration: request.generation,
        stagedGeneration: null,
        retainedGenerations,
      });
      if (state.activeGeneration !== request.generation) throw new Error('Linux refresh restoration state is not exact');
    },
  });
}
