import { createEnvironmentBridge } from './environment-bridge.js';
import { createEnvironmentConstruction, createEnvironmentConstructionPipeline } from './environment-construction.js';
import { createEnvironmentConstructionObservation } from './environment-construction-observation.js';
import {
  createEnvironmentImagePort,
  createEnvironmentResourcePort,
} from './environment-construction-ports.js';
import { createEnvironmentConstructionPreparation } from './environment-construction-preparation.js';
import { createEnvironmentConstructionWorkspaces } from './environment-construction-workspaces.js';
import { createEnvironmentFoundation } from './environment-foundation.js';
import { createEnvironmentImageAvailability } from './environment-image-availability.js';
import { createEnvironmentLifecycle } from './environment-lifecycle.js';
import { createEnvironmentMaterialization, createEnvironmentRebuildMaterialization } from './environment-materialization.js';
import { createEnvironmentMaterializationPolicy } from './environment-materialization-policy.js';
import { createEnvironmentRecreateMaterialization, createEnvironmentRecreateRetirement } from './environment-recreate.js';
import { createEnvironmentRecovery } from './environment-recovery.js';
import { createEnvironmentResetMaterialization, createEnvironmentResetRetirement } from './environment-reset.js';
import { invokeCommand } from '../runtime/command-invocation.js';

function assertAvailability(value) {
  if (!value || typeof value.ensure !== 'function') throw new TypeError('environment construction image availability contract is incomplete');
  return value;
}

export async function createEnvironmentConstructionRuntime({
  stateDirectory,
  authorityDirectory = null,
  availability = null,
  source = null,
  codec = null,
  capacity = null,
  resolveAuthority,
  platform = process.platform,
  invoke = invokeCommand,
  foundation = null,
  lifecycle = null,
  fence = null,
  windowsAccess = null,
  resetAuthorization = null,
  recreateAuthorization = null,
  now,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0) throw new TypeError('environment construction runtime stateDirectory is required');
  if (authorityDirectory != null && (typeof authorityDirectory !== 'string' || authorityDirectory.length === 0)) {
    throw new TypeError('environment construction runtime authorityDirectory must be a non-empty string when provided');
  }
  if (typeof resolveAuthority !== 'function') throw new TypeError('environment construction runtime authority resolver is required');
  if (typeof invoke !== 'function') throw new TypeError('environment construction runtime invocation contract is invalid');

  const authorityStateDirectory = authorityDirectory ?? stateDirectory;
  const localFoundation = foundation ?? await createEnvironmentFoundation({ stateDirectory: authorityStateDirectory, platform, invoke });
  const localAvailability = availability == null
    ? createEnvironmentImageAvailability({ stateDirectory: authorityStateDirectory, foundation: localFoundation, source, codec, capacity })
    : assertAvailability(availability);
  const localLifecycle = lifecycle ?? createEnvironmentLifecycle({ stateDirectory: authorityStateDirectory, ...(now ? { now } : {}) });
  const policy = createEnvironmentMaterializationPolicy();
  const materialization = createEnvironmentMaterialization({ state: localFoundation, subject: policy.subject, settings: policy.settings });
  const rebuildMaterialization = createEnvironmentRebuildMaterialization({ state: localFoundation, subject: policy.subject, journal: localLifecycle.journal });
  const resetAvailable = typeof localFoundation.replaceEnvironment === 'function' && typeof localFoundation.retireSupersededEnvironment === 'function';
  const resetMaterialization = resetAvailable ? createEnvironmentResetMaterialization({ state: localFoundation, subject: policy.subject, journal: localLifecycle.journal }) : null;
  const resetRetirement = resetAvailable ? createEnvironmentResetRetirement({ state: localFoundation, journal: localLifecycle.journal }) : null;
  const recreateAvailable = typeof localFoundation.recreateEnvironment === 'function' && typeof localFoundation.retireSupersededEnvironment === 'function';
  const recreateMaterialization = recreateAvailable ? createEnvironmentRecreateMaterialization({ state: localFoundation, subject: policy.subject, journal: localLifecycle.journal }) : null;
  const recreateRetirement = recreateAvailable ? createEnvironmentRecreateRetirement({ state: localFoundation, journal: localLifecycle.journal }) : null;
  const preparation = createEnvironmentConstructionPreparation({
    stateDirectory,
    authorityDirectory: authorityStateDirectory,
    platform,
    invoke,
    windowsAccess,
  });
  const workspaces = createEnvironmentConstructionWorkspaces({
    stateDirectory,
    state: localFoundation,
    resolveAuthority,
    resolveChannel: async ({ declaration }) => createEnvironmentBridge({
      stateDirectory,
      platform,
      invoke,
      access: (target) => preparation.connection({ declaration }, target),
    }),
  });
  const observation = createEnvironmentConstructionObservation({ materialization, preparation, workspaces });
  if (!fence || typeof fence !== 'object' || Array.isArray(fence) || typeof fence.acquire !== 'function') {
    throw new TypeError('environment construction runtime fence contract is incomplete');
  }
  const localFence = fence;
  const resources = createEnvironmentResourcePort({ state: localFoundation, settings: policy.settings });
  const image = createEnvironmentImagePort({ availability: localAvailability });
  const construction = createEnvironmentConstruction({
    stateDirectory: authorityStateDirectory, lifecycle: localLifecycle, observer: observation, fence: localFence, image, resources,
    materialization, preparation, workspaces, readiness: observation.readiness, ...(now ? { now } : {}),
  });
  const rebuildConstruction = createEnvironmentConstructionPipeline({
    stateDirectory: authorityStateDirectory, image, resources, materialization: rebuildMaterialization, preparation, workspaces,
    readiness: observation.readiness, ...(now ? { now } : {}),
  });
  const resetConstruction = resetAvailable ? createEnvironmentConstructionPipeline({
    stateDirectory: authorityStateDirectory, image, resources, materialization: resetMaterialization, preparation, workspaces,
    readiness: observation.readiness, ...(now ? { now } : {}),
  }) : null;
  const recreateConstruction = recreateAvailable ? createEnvironmentConstructionPipeline({
    stateDirectory: authorityStateDirectory, image, resources, materialization: recreateMaterialization, preparation, workspaces,
    readiness: observation.readiness, ...(now ? { now } : {}),
  }) : null;
  const recovery = createEnvironmentRecovery({
    lifecycle: localLifecycle,
    observer: observation,
    fence: localFence,
    foundation: localFoundation,
    materialization,
    preparation,
    workspaces,
    rebuildConstruction,
    recreateConstruction,
    recreateRetirement,
    recreateAuthorization,
    resetConstruction,
    resetRetirement,
    resetAuthorization,
  });

  return Object.freeze({
    lifecycle: localLifecycle,
    foundation: localFoundation,
    availability: localAvailability,
    observer: observation,
    list: recovery.list,
    create: construction.create,
    pipeline: construction.pipeline,
    diagnosis: recovery.diagnosis,
    diagnose: recovery.diagnose,
    repair: recovery.repair,
    planRebuild: recovery.planRebuild,
    rebuild: recovery.rebuild,
    planRecreate: recovery.planRecreate,
    recreate: recovery.recreate,
    planReset: recovery.planReset,
    reset: recovery.reset,
  });
}
