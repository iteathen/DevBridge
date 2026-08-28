import path from 'node:path';
import { ChatHandoffStore } from '../context/chat-handoff.js';
import { JsonStateStore } from '../state/json-state-store.js';
import { stateFileName } from '../state/state-file.js';
import { selectConfiguredQueue } from './queue-selection.js';

export function createLocalChatHandoffStore(config, repository = null) {
  const selected = selectConfiguredQueue(config, repository);
  const stateStore = new JsonStateStore(path.join(config.state.directory, stateFileName(selected)));
  return new ChatHandoffStore({
    stateStore,
    maxBytes: config.contextRollover.maxHandoffBytes,
    maxRetained: config.contextRollover.maxRetained,
  });
}

export async function chatHandoffStatus(config, repository = null) {
  const selected = selectConfiguredQueue(config, repository);
  const store = createLocalChatHandoffStore(config, selected);
  const latest = await store.loadLatest(selected);
  if (!latest) return { ready: false, repository: selected };
  return {
    ready: true,
    repository: selected,
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

export async function chatHandoffSeed(config, repository = null) {
  const status = await chatHandoffStatus(config, repository);
  return status.ready ? status.seed : null;
}
