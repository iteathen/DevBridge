import { createHash } from 'node:crypto';
import {
  APPLICATION_REMOVAL_PROTOCOL,
  normalizeRemovalSnapshot,
  REMOVAL_MODES,
  safeIdentity,
} from './contract.js';

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizeRequired(raw) {
  const value = exactObject(raw, new Set(REMOVAL_MODES), 'removal source requirements');
  return Object.freeze(Object.fromEntries(REMOVAL_MODES.map((mode) => {
    if (!Array.isArray(value[mode]) || value[mode].length === 0) {
      throw new TypeError(`removal source requirements.${mode} must be a non-empty array`);
    }
    const identities = value[mode].map((identity, index) => safeIdentity(identity, `removal source requirements.${mode}[${index}]`));
    if (new Set(identities).size !== identities.length) throw new TypeError(`removal source requirements.${mode} contains duplicates`);
    return [mode, Object.freeze([...identities].sort((left, right) => left.localeCompare(right)))];
  })));
}

function normalizeContributor(raw, index) {
  const value = exactObject(raw, new Set(['identity', 'snapshot', 'run']), `removal source contributor ${index}`);
  if (typeof value.snapshot !== 'function' || typeof value.run !== 'function') {
    throw new TypeError(`removal source contributor ${index} contract is incomplete`);
  }
  return Object.freeze({
    identity: safeIdentity(value.identity, `removal source contributor ${index}.identity`),
    snapshot: value.snapshot.bind(value),
    run: value.run.bind(value),
  });
}

function normalizeFragment(raw, identity) {
  const value = exactObject(
    raw,
    new Set(['generation', 'coverage', 'mutationActive', 'protectedReferences', 'items']),
    `removal source contributor ${identity} snapshot`,
  );
  return normalizeRemovalSnapshot({ protocol: APPLICATION_REMOVAL_PROTOCOL, ...value });
}

export function createApplicationRemovalSource({ contributors, required } = {}) {
  if (!Array.isArray(contributors)) throw new TypeError('removal source contributors must be an array');
  const selected = Object.freeze(contributors.map(normalizeContributor).sort((left, right) => left.identity.localeCompare(right.identity)));
  if (new Set(selected.map((entry) => entry.identity)).size !== selected.length) {
    throw new TypeError('removal source contributors contain duplicate identities');
  }
  const requirements = normalizeRequired(required);

  return Object.freeze({
    async snapshot() {
      const fragments = await Promise.all(selected.map(async (entry) => Object.freeze({
        identity: entry.identity,
        value: normalizeFragment(await entry.snapshot(), entry.identity),
      })));
      const byIdentity = new Map(fragments.map((entry) => [entry.identity, entry.value]));
      const coverage = REMOVAL_MODES.filter((mode) => requirements[mode].every((identity) => byIdentity.get(identity)?.coverage.includes(mode)));
      const generationEvidence = Object.freeze({
        required: requirements,
        observed: Object.freeze(fragments.map((entry) => Object.freeze({
          identity: entry.identity,
          generation: entry.value.generation,
        }))),
      });
      return normalizeRemovalSnapshot({
        protocol: APPLICATION_REMOVAL_PROTOCOL,
        generation: `generation-${digest(generationEvidence)}`,
        coverage,
        mutationActive: fragments.some((entry) => entry.value.mutationActive),
        protectedReferences: [...new Set(fragments.flatMap((entry) => entry.value.protectedReferences))],
        items: fragments.flatMap((entry) => entry.value.items),
      });
    },
    async run(rawMode, operation) {
      const mode = REMOVAL_MODES.includes(rawMode) ? rawMode : null;
      if (!mode || typeof operation !== 'function') throw new TypeError('removal source operation is invalid');
      const byIdentity = new Map(selected.map((entry) => [entry.identity, entry]));
      const requiredIdentities = requirements[mode];
      if (requiredIdentities.some((identity) => !byIdentity.has(identity))) {
        throw new Error('removal mode coverage is incomplete');
      }
      async function enter(index) {
        if (index === requiredIdentities.length) return operation();
        return byIdentity.get(requiredIdentities[index]).run(() => enter(index + 1));
      }
      return enter(0);
    },
  });
}
