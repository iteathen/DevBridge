import { ControllerInputRegistry } from '../run/controller-input-registry.js';
import { createRepositoryHistoryInput } from '../git/repository-history-input.js';

const PREVIOUS_ENTRY_SUBJECT = '32a782e939339928919b4117af18fcaeb517d741';
const PREVIOUS_ENTRY_SOURCE = 'compatibility.previous-entry';
const PREVIOUS_ENTRY_DESTINATION = 'test/fixtures/devbridge-previous-entry.bundle';

export function composeControllerInputs({ gitClient, effectGuard = async () => {} } = {}) {
  const registry = new ControllerInputRegistry({ effectGuard });
  registry.register(PREVIOUS_ENTRY_SOURCE, createRepositoryHistoryInput({
    gitClient,
    subject: PREVIOUS_ENTRY_SUBJECT,
    sourceRef: 'refs/remotes/origin/main',
    destination: PREVIOUS_ENTRY_DESTINATION,
  }));
  return registry;
}

export const controllerInputCompatibility = Object.freeze({
  source: PREVIOUS_ENTRY_SOURCE,
  destination: PREVIOUS_ENTRY_DESTINATION,
  subject: PREVIOUS_ENTRY_SUBJECT,
});
