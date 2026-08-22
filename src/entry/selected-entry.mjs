import { runExperimentalEntry } from './experimental-entry.mjs';

export async function runSelectedEntry(argv, { entry = runExperimentalEntry } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('selected-entry argv must be an array');
  if (typeof entry !== 'function') throw new TypeError('selected-entry target must be a function');
  return entry([...argv]);
}
