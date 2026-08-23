import { EnvironmentDiagnosisService } from '../runtime/environment-diagnosis.js';
import { EnvironmentRebuild } from '../runtime/environment-rebuild.js';
import { EnvironmentRecreate } from '../runtime/environment-recreate.js';
import { EnvironmentRepair } from '../runtime/environment-repair.js';
import { EnvironmentReset } from '../runtime/environment-reset.js';

function assertPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`environment recovery ${name} contract is incomplete`);
  return value;
}

function requestWithCurrent(input) {
  return Object.freeze({
    environmentIdentity: input.environmentIdentity,
    operationId: input.operationId,
    declarationRevision: input.declarationRevision,
    declaration: input.declaration,
    implementationGeneration: input.implementationGeneration,
    enrollment: input.declaration.enrollment,
    bootstrap: input.declaration.bootstrap,
    workspaces: input.declaration.workspaces,
  });
}

export function createEnvironmentRecoveryEvidence({ foundation, preparation, workspaces } = {}) {
  const state = assertPort(foundation, ['inspect'], 'state evidence');
  const preparationPort = assertPort(preparation, ['inspect'], 'preparation evidence');
  const workspacePort = assertPort(workspaces, ['inspect'], 'workspace evidence');
  return Object.freeze({
    async inspect({ record, observation }) {
      let foundationStatus = null;
      try { foundationStatus = await state.inspect(); } catch {}
      const managementReady = foundationStatus?.capabilities?.management?.ready === true;
      const storageReady = foundationStatus?.capabilities?.storage?.ready === true;
      const networkReady = foundationStatus?.capabilities?.networking?.ready === true;
      let network = networkReady ? 'ready' : foundationStatus == null ? 'unknown' : 'degraded';
      let workspaceState = 'ready';

      if (observation?.materialization === 'present' && observation?.implementationGeneration != null) {
        const request = requestWithCurrent({
          environmentIdentity: record.identity,
          operationId: 'diagnosis',
          declarationRevision: record.revision,
          declaration: record.declaration,
          implementationGeneration: observation.implementationGeneration,
        });
        const prepared = await preparationPort.inspect(request);
        const workspace = await workspacePort.inspect(request);
        if (prepared?.network === 'degraded') network = 'degraded';
        workspaceState = workspace?.ready === true ? 'ready' : 'degraded';
      } else if (observation?.materialization === 'unavailable') {
        workspaceState = 'unknown';
      }

      return Object.freeze({
        resources: foundationStatus == null ? 'unknown' : managementReady && storageReady ? 'ready' : 'blocked',
        network,
        workspaces: workspaceState,
      });
    },
  });
}

export function createEnvironmentRepairCorrection({ foundation, materialization, preparation, workspaces } = {}) {
  const state = assertPort(foundation, ['reconcile', 'ensureNetwork'], 'correction state');
  const materializationPort = assertPort(materialization, ['ensure'], 'materialization correction');
  const preparationPort = assertPort(preparation, ['ensure'], 'preparation correction');
  const workspacePort = assertPort(workspaces, ['ensure'], 'workspace correction');
  return Object.freeze({
    async ensure(input) {
      const request = requestWithCurrent(input);
      if (input.cause === 'transition-incomplete') {
        await state.reconcile();
        return Object.freeze({ ready: true });
      }
      if (input.cause === 'network-degraded') {
        const network = await state.ensureNetwork();
        if (network?.ready !== true) throw new Error(network?.reason ?? 'environment network did not become ready');
        await preparationPort.ensure(request);
        return Object.freeze({ ready: true });
      }
      if (input.cause === 'attachment-invalid') {
        const result = await materializationPort.ensure(request);
        if (result?.ready !== true || result.implementationGeneration !== input.implementationGeneration) throw new Error('environment attachment repair did not preserve the implementation generation');
        return Object.freeze({ ready: true });
      }
      if (['enrollment-missing', 'enrollment-stale', 'bootstrap-degraded'].includes(input.cause)) {
        const result = await preparationPort.ensure(request);
        if (result?.ready !== true || result.implementationGeneration !== input.implementationGeneration) throw new Error('environment preparation repair did not preserve the implementation generation');
        return Object.freeze({ ready: true });
      }
      if (['workspace-degraded', 'guest-degraded'].includes(input.cause)) {
        const prepared = await preparationPort.ensure(request);
        if (prepared?.ready !== true || prepared.implementationGeneration !== input.implementationGeneration) throw new Error('environment guest repair did not preserve the implementation generation');
        const workspace = await workspacePort.ensure(request);
        if (workspace?.ready !== true || workspace.implementationGeneration !== input.implementationGeneration) throw new Error('environment workspace repair did not preserve the implementation generation');
        return Object.freeze({ ready: true });
      }
      throw new Error(`environment repair correction does not support cause: ${String(input.cause)}`);
    },
  });
}

export function createEnvironmentRecovery({
  lifecycle,
  observer,
  fence,
  foundation,
  materialization,
  preparation,
  workspaces,
  rebuildConstruction = null,
  recreateConstruction = null,
  recreateRetirement = null,
  recreateAuthorization = null,
  resetConstruction = null,
  resetRetirement = null,
  resetAuthorization = null,
} = {}) {
  if (!lifecycle?.declarations || !lifecycle?.journal) throw new TypeError('environment recovery lifecycle contract is incomplete');
  const localObserver = assertPort(observer, ['observe'], 'observation');
  const localFence = assertPort(fence, ['acquire'], 'fence');
  const evidence = createEnvironmentRecoveryEvidence({ foundation, preparation, workspaces });
  const correction = createEnvironmentRepairCorrection({ foundation, materialization, preparation, workspaces });
  const diagnosis = new EnvironmentDiagnosisService({
    declarations: lifecycle.declarations,
    journal: lifecycle.journal,
    observer: localObserver,
    evidence,
  });
  const repair = new EnvironmentRepair({
    declarations: lifecycle.declarations,
    journal: lifecycle.journal,
    observer: localObserver,
    fence: localFence,
    correction,
    evidence,
  });
  const rebuild = rebuildConstruction == null ? null : new EnvironmentRebuild({
    declarations: lifecycle.declarations,
    journal: lifecycle.journal,
    observer: localObserver,
    fence: localFence,
    construction: assertPort(rebuildConstruction, ['run', 'clear'], 'rebuild construction'),
    evidence,
  });
  const recreate = recreateConstruction == null || recreateRetirement == null ? null : new EnvironmentRecreate({
    declarations: lifecycle.declarations,
    journal: lifecycle.journal,
    observer: localObserver,
    fence: localFence,
    construction: assertPort(recreateConstruction, ['run', 'clear'], 'recreate construction'),
    retirement: assertPort(recreateRetirement, ['ensure'], 'recreate retirement'),
    evidence,
    authorization: recreateAuthorization,
  });
  const reset = resetConstruction == null || resetRetirement == null ? null : new EnvironmentReset({
    declarations: lifecycle.declarations,
    journal: lifecycle.journal,
    observer: localObserver,
    fence: localFence,
    construction: assertPort(resetConstruction, ['run', 'clear'], 'reset construction'),
    retirement: assertPort(resetRetirement, ['ensure'], 'reset retirement'),
    evidence,
    authorization: resetAuthorization,
  });
  return Object.freeze({
    diagnosis,
    diagnose: (identity) => diagnosis.diagnose(identity),
    list: () => diagnosis.list(),
    repair: (identity) => repair.repair(identity),
    planRebuild: rebuild == null ? null : (identity) => rebuild.plan(identity),
    rebuild: rebuild == null ? null : (identity) => rebuild.rebuild(identity),
    planRecreate: recreate == null ? null : (identity) => recreate.plan(identity),
    recreate: recreate == null ? null : (identity, options) => recreate.recreate(identity, options),
    planReset: reset == null ? null : (identity) => reset.plan(identity),
    reset: reset == null ? null : (identity, options) => reset.reset(identity, options),
  });
}
