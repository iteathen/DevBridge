import {
  environmentObservationCondition,
  normalizeEnvironmentObservation,
} from '../runtime/environment-observation.js';

function assertPort(value, method, name) {
  if (!value || typeof value[method] !== 'function') throw new TypeError(`environment construction ${name} contract is incomplete`);
  return value;
}

function requestWithGeneration(request, generation) {
  return Object.freeze({
    ...request,
    implementationGeneration: generation,
    enrollment: request.declaration.enrollment,
    bootstrap: request.declaration.bootstrap,
    workspaces: request.declaration.workspaces,
  });
}

export function createEnvironmentConstructionObservation({ materialization, preparation, workspaces } = {}) {
  const materializationPort = assertPort(materialization, 'observe', 'materialization observation');
  const preparationPort = assertPort(preparation, 'inspect', 'preparation observation');
  const workspacePort = assertPort(workspaces, 'inspect', 'workspace observation');

  const assess = async (request) => {
    const base = normalizeEnvironmentObservation(await materializationPort.observe(request));
    if (base.materialization !== 'present'
        || base.systemStorage !== 'present'
        || base.attachment !== 'ready'
        || base.implementationGeneration == null) {
      return { observation: base, reason: null };
    }

    const selected = requestWithGeneration(request, base.implementationGeneration);
    const prepared = await preparationPort.inspect(selected);
    const workspace = await workspacePort.inspect(selected);
    const enrollment = ['ready', 'missing', 'stale'].includes(prepared?.enrollment) ? prepared.enrollment : 'unknown';
    const bootstrap = ['ready', 'degraded'].includes(prepared?.bootstrap) ? prepared.bootstrap : 'unknown';
    const guest = prepared?.ready === true && workspace?.ready === true ? 'healthy' : 'degraded';

    const observation = normalizeEnvironmentObservation({
      ...base,
      enrollment,
      bootstrap,
      guest,
    });
    const blocker = prepared?.ready !== true ? prepared : workspace?.ready !== true ? workspace : null;
    const reason = typeof blocker?.reason === 'string'
      ? blocker.reason.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 1024)
      : null;
    return { observation, reason };
  };

  return Object.freeze({
    observe: async (request) => (await assess(request)).observation,
    readiness: Object.freeze({
      async verify(request) {
        const { observation, reason } = await assess(request);
        const condition = environmentObservationCondition(observation);
        if (condition !== 'healthy') throw new Error(`environment construction readiness is not healthy: ${condition}${reason ? `; ${reason}` : ''}`);
        return Object.freeze({
          ready: true,
          implementationGeneration: observation.implementationGeneration,
          observation,
        });
      },
    }),
  });
}
