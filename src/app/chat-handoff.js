import path from 'node:path';
import { ChatHandoffStore } from '../context/chat-handoff.js';
import { JsonStateStore } from '../state/json-state-store.js';
import { stateFileName } from '../state/state-file.js';

export function createLocalChatHandoffStore(config, queueRepository) {
  if (typeof queueRepository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(queueRepository)) {
    throw new TypeError('chat handoff queue repository must be owner/name');
  }
  const stateStore = new JsonStateStore(path.join(config.state.directory, stateFileName(queueRepository)));
  return new ChatHandoffStore({
    stateStore,
    maxBytes: config.contextRollover.maxHandoffBytes,
    maxRetained: config.contextRollover.maxRetained,
  });
}

export async function chatHandoffStatus(config, repository) {
  const store = createLocalChatHandoffStore(config, repository);
  const latest = await store.loadLatest(repository);
  if (!latest) return { ready: false, repository };
  return {
    ready: true,
    repository,
    recoveredFromPrevious: latest.recoveredFromPrevious === true,
    recoveryError: latest.recoveryError ?? null,
    handoffId: latest.record.handoff.handoffId,
    sequence: latest.record.handoff.sequence,
    digest: latest.record.digest,
    phase: latest.record.handoff.phase,
    headSha: latest.record.handoff.headSha,
    nextActionId: latest.record.handoff.nextActionId,
    seed: latest.seed,
    handoff: latest.record.handoff,
  };
}

export async function chatHandoffSeed(config, repository) {
  const status = await chatHandoffStatus(config, repository);
  return status.ready ? status.seed : null;
}
