import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const EXACT_ARTIFACT_INVENTORY_PROTOCOL = 'devbridge/exact-artifact-inventory-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const STATES = new Set(['absent', 'created', 'adopted', 'foreign']);

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function identity(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function identities(raw, name) {
  if (!Array.isArray(raw) || raw.length > 4096) throw new TypeError(`${name} is invalid`);
  const values = raw.map((value, index) => identity(value, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
}

function coverage(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16) {
    throw new TypeError('artifact inventory coverage is invalid');
  }
  return identities(raw, 'artifact inventory coverage');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function exactJson(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  try {
    const clone = structuredClone(value);
    const encoded = JSON.stringify(clone);
    if (encoded == null || encoded.length > 32 * 1024 * 1024 || !isDeepStrictEqual(JSON.parse(encoded), clone)) {
      throw new Error('not bounded exact JSON');
    }
    return Object.freeze(clone);
  } catch (error) {
    throw new TypeError(`${name} must be exact JSON data`, { cause: error });
  }
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

function sourceObservation(raw, expectedIdentity) {
  const value = exactObject(raw, new Set(['identity', 'generation', 'state']), 'artifact inventory source observation');
  if (value.identity !== expectedIdentity || !STATES.has(value.state)) throw new TypeError('artifact inventory source observation is invalid');
  return Object.freeze({
    identity: expectedIdentity,
    generation: identity(value.generation, 'artifact inventory source generation'),
    state: value.state,
  });
}

function activityObservation(raw, expectedIdentity) {
  const value = exactObject(raw, new Set(['identity', 'active']), 'artifact inventory activity observation');
  if (value.identity !== expectedIdentity || typeof value.active !== 'boolean') throw new TypeError('artifact inventory activity observation is invalid');
  return Object.freeze({ identity: expectedIdentity, active: value.active });
}

function actionValue(raw, expectedIdentity) {
  const value = exactJson(raw, 'artifact inventory action value');
  if (value.identity !== expectedIdentity || typeof value.digest !== 'string' || !SHA256.test(value.digest)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new TypeError('artifact inventory action value is invalid');
  }
  return value;
}

function actionObservation(raw, expectedIdentity) {
  const value = exactObject(raw, new Set(['identity', 'state', 'retryable']), 'artifact inventory action observation');
  if (value.identity !== expectedIdentity || !['present', 'absent', 'ambiguous'].includes(value.state)
      || typeof value.retryable !== 'boolean') {
    throw new TypeError('artifact inventory action observation is invalid');
  }
  return Object.freeze({ ...value });
}

function effectIdentity(itemIdentity, value) {
  return `effect-${digest({ itemIdentity, value })}`;
}

function fragment({ itemIdentity, scope, coverage, protections, references, after, source, value = null, mutationActive }) {
  let items = [];
  if (source.state === 'foreign') {
    items = [{
      identity: itemIdentity,
      scope,
      provenance: 'foreign',
      protections,
      references,
      after,
      effects: [],
    }];
  } else if (['created', 'adopted'].includes(source.state)) {
    const actionIdentity = effectIdentity(itemIdentity, value);
    items = [{
      identity: itemIdentity,
      scope,
      provenance: source.state,
      protections,
      references,
      after,
      effects: [{ identity: actionIdentity, bytes: value.bytes, terminal: true }],
    }];
  }
  return Object.freeze({
    generation: `generation-${digest({ itemIdentity, source, value, coverage, protections, references, after })}`,
    coverage,
    mutationActive,
    protectedReferences: Object.freeze([]),
    items: Object.freeze(items.map((item) => Object.freeze({
      ...item,
      protections: Object.freeze([...item.protections]),
      references: Object.freeze([...item.references]),
      after: Object.freeze([...item.after]),
      effects: Object.freeze(item.effects.map((effect) => Object.freeze({ ...effect }))),
    }))),
  });
}

function actionInput(raw) {
  const value = exactObject(raw, new Set(['protocol', 'mode', 'item', 'planDigest', 'effect']), 'artifact inventory binding input');
  const effect = exactObject(value.effect, new Set(['identity', 'bytes', 'terminal']), 'artifact inventory binding effect');
  if (typeof value.protocol !== 'string' || value.protocol.length === 0 || value.protocol.length > 256
      || typeof value.mode !== 'string' || !SAFE_ID.test(value.mode)
      || typeof value.item !== 'string' || !SAFE_ID.test(value.item)
      || typeof effect.identity !== 'string' || !SAFE_ID.test(effect.identity)
      || typeof value.planDigest !== 'string' || !SHA256.test(value.planDigest)
      || !Number.isSafeInteger(effect.bytes) || effect.bytes < 0 || typeof effect.terminal !== 'boolean') {
    throw new TypeError('artifact inventory binding input is invalid');
  }
  return Object.freeze({ ...value, effect: Object.freeze({ ...effect }) });
}

function storedRecord(raw, expectedIdentity) {
  const value = exactObject(
    raw,
    new Set(['protocol', 'revision', 'identity', 'source', 'plan', 'value']),
    'artifact inventory record',
  );
  if (value.protocol !== EXACT_ARTIFACT_INVENTORY_PROTOCOL || value.identity !== expectedIdentity
      || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new TypeError('artifact inventory record identity is invalid');
  }
  const source = sourceObservation(value.source, expectedIdentity);
  if (!['created', 'adopted'].includes(source.state)) throw new TypeError('artifact inventory record source is invalid');
  const plan = actionInput(value.plan);
  if (plan.item !== expectedIdentity) throw new TypeError('artifact inventory record item is invalid');
  const actionSetIdentity = identity(value.value?.identity, 'artifact inventory stored action identity');
  const selectedValue = actionValue(value.value, actionSetIdentity);
  const expectedEffect = effectIdentity(expectedIdentity, selectedValue);
  if (plan.effect.identity !== expectedEffect || plan.effect.bytes !== selectedValue.bytes || plan.effect.terminal !== true) {
    throw new TypeError('artifact inventory record effect changed');
  }
  return Object.freeze({ ...value, source, plan, value: selectedValue });
}

function binding(record) {
  return Object.freeze({
    protocol: record.plan.protocol,
    mode: record.plan.mode,
    item: record.plan.item,
    identity: record.plan.effect.identity,
    planDigest: record.plan.planDigest,
    bound: true,
    value: structuredClone(record.value),
  });
}

function sameInput(record, input) {
  return record.plan.protocol === input.protocol && record.plan.mode === input.mode && record.plan.item === input.item
    && record.plan.planDigest === input.planDigest && isDeepStrictEqual(record.plan.effect, input.effect);
}

export function createExactArtifactInventory({
  identity: rawIdentity,
  location,
  scope,
  coverage: rawCoverage,
  protections: rawProtections = [],
  references: rawReferences = [],
  after: rawAfter = [],
  source,
  activity,
  records,
  actions,
} = {}) {
  const itemIdentity = identity(rawIdentity, 'artifact inventory identity');
  if (typeof location !== 'string' || location.length === 0 || location.includes('\0')) throw new TypeError('artifact inventory location is invalid');
  const selectedScope = identity(scope, 'artifact inventory scope');
  const selectedCoverage = coverage(rawCoverage);
  const selectedProtections = identities(rawProtections, 'artifact inventory protections');
  const selectedReferences = identities(rawReferences, 'artifact inventory references');
  const selectedAfter = identities(rawAfter, 'artifact inventory dependencies');
  if (selectedAfter.includes(itemIdentity)) throw new TypeError('artifact inventory cannot depend on itself');
  const selectedSource = requirePort(source, ['observe'], 'artifact inventory source');
  const selectedActivity = requirePort(activity, ['observe'], 'artifact inventory activity');
  const selectedRecords = requirePort(records, ['run'], 'artifact inventory records');
  const selectedActions = requirePort(actions, ['discover', 'observe'], 'artifact inventory actions');
  let pending = null;

  async function readRecord() {
    return selectedRecords.run(itemIdentity, async (session) => {
      requirePort(session, ['load', 'save'], 'artifact inventory record session');
      const raw = await session.load();
      return raw == null ? null : storedRecord(raw, itemIdentity);
    });
  }

  function fromRecord(record, active) {
    return fragment({
      itemIdentity,
      scope: selectedScope,
      coverage: selectedCoverage,
      protections: selectedProtections,
      references: selectedReferences,
      after: selectedAfter,
      source: record.source,
      value: record.value,
      mutationActive: active,
    });
  }

  async function snapshot() {
    const [record, observedActivity] = await Promise.all([
      readRecord(),
      selectedActivity.observe(Object.freeze({ identity: itemIdentity })).then((value) => activityObservation(value, itemIdentity)),
    ]);
    if (record) return fromRecord(record, observedActivity.active);
    if (observedActivity.active) {
      pending = null;
      return fragment({
        itemIdentity,
        scope: selectedScope,
        coverage: selectedCoverage,
        protections: selectedProtections,
        references: selectedReferences,
        after: selectedAfter,
        source: { identity: itemIdentity, generation: 'activity-active', state: 'absent' },
        mutationActive: true,
      });
    }

    const before = sourceObservation(await selectedSource.observe(Object.freeze({ identity: itemIdentity })), itemIdentity);
    if (['absent', 'foreign'].includes(before.state)) {
      pending = null;
      return fragment({
        itemIdentity,
        scope: selectedScope,
        coverage: selectedCoverage,
        protections: selectedProtections,
        references: selectedReferences,
        after: selectedAfter,
        source: before,
        mutationActive: false,
      });
    }

    const setIdentity = `set-${digest({ itemIdentity, generation: before.generation, location }).slice(0, 40)}`;
    const value = actionValue(await selectedActions.discover(Object.freeze({ identity: setIdentity, root: location })), setIdentity);
    const observed = actionObservation(await selectedActions.observe(structuredClone(value)), setIdentity);
    if (observed.state !== 'present') throw new Error('artifact inventory discovery did not re-observe exact presence');
    const [afterSource, afterActivity] = await Promise.all([
      selectedSource.observe(Object.freeze({ identity: itemIdentity })).then((entry) => sourceObservation(entry, itemIdentity)),
      selectedActivity.observe(Object.freeze({ identity: itemIdentity })).then((entry) => activityObservation(entry, itemIdentity)),
    ]);
    if (!isDeepStrictEqual(afterSource, before)) throw new Error('artifact inventory source changed during discovery');
    const projected = fragment({
      itemIdentity,
      scope: selectedScope,
      coverage: selectedCoverage,
      protections: selectedProtections,
      references: selectedReferences,
      after: selectedAfter,
      source: before,
      value,
      mutationActive: afterActivity.active,
    });
    pending = Object.freeze({ source: before, value, fragment: projected });
    return projected;
  }

  async function bindAction(rawInput) {
    const input = actionInput(rawInput);
    if (input.item !== itemIdentity) throw new Error('artifact inventory binding selected another item');
    let current = await readRecord();
    if (!current && !pending) await snapshot();
    if (!current && pending) {
      const [observedSource, observedActivity, observedAction] = await Promise.all([
        selectedSource.observe(Object.freeze({ identity: itemIdentity })).then((entry) => sourceObservation(entry, itemIdentity)),
        selectedActivity.observe(Object.freeze({ identity: itemIdentity })).then((entry) => activityObservation(entry, itemIdentity)),
        selectedActions.observe(structuredClone(pending.value)).then((entry) => actionObservation(entry, pending.value.identity)),
      ]);
      if (!isDeepStrictEqual(observedSource, pending.source) || observedActivity.active || observedAction.state !== 'present') {
        throw new Error('artifact inventory binding changed before acceptance');
      }
    }
    return selectedRecords.run(itemIdentity, async (session) => {
      requirePort(session, ['load', 'save'], 'artifact inventory record session');
      const raw = await session.load();
      current = raw == null ? null : storedRecord(raw, itemIdentity);
      if (current) {
        if (!sameInput(current, input)) throw new Error('artifact inventory binding conflicts with durable evidence');
        return binding(current);
      }
      const effect = pending?.fragment.items[0]?.effects[0];
      if (!pending || input.effect.identity !== effect?.identity || input.effect.bytes !== effect.bytes || input.effect.terminal !== true) {
        throw new Error('artifact inventory binding changed after observation');
      }
      const next = storedRecord({
        protocol: EXACT_ARTIFACT_INVENTORY_PROTOCOL,
        revision: 1,
        identity: itemIdentity,
        source: pending.source,
        plan: input,
        value: pending.value,
      }, itemIdentity);
      await session.save(next);
      return binding(next);
    });
  }

  async function loadAction(rawInput) {
    const input = actionInput(rawInput);
    if (input.item !== itemIdentity) throw new Error('artifact inventory lookup selected another item');
    const current = await readRecord();
    if (!current || !sameInput(current, input)) throw new Error('artifact inventory binding is unavailable');
    return binding(current);
  }

  return Object.freeze({ identity: itemIdentity, snapshot, bind: bindAction, load: loadAction });
}
