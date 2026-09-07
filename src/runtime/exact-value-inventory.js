import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

export const EXACT_VALUE_INVENTORY_PROTOCOL = 'devbridge/exact-value-inventory-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROVENANCE = new Set(['created', 'adopted']);
const MAX_ITEMS = 4096;
const MAX_VALUE_BYTES = 32 * 1024 * 1024;
const AMBIGUOUS_PROTECTION = 'state-ambiguous';
const BINDING_PHASES = new Set(['bound', 'retired']);

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
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) throw new TypeError(`${name} is invalid`);
  const values = raw.map((value, index) => identity(value, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
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
    if (encoded == null || Buffer.byteLength(encoded, 'utf8') > MAX_VALUE_BYTES
        || !isDeepStrictEqual(JSON.parse(encoded), clone)) throw new Error('not bounded exact JSON');
    return Object.freeze(clone);
  } catch (error) {
    throw new TypeError(`${name} must be exact JSON data`, { cause: error });
  }
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

function actionValue(raw, name) {
  const value = exactJson(raw, name);
  if (typeof value.identity !== 'string' || !SAFE_ID.test(value.identity)
      || typeof value.digest !== 'string' || !SHA256.test(value.digest)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function sourceItem(raw, index) {
  const value = exactObject(
    raw,
    new Set(['identity', 'provenance', 'protections', 'references', 'after', 'value']),
    `value inventory source item ${index}`,
  );
  const selectedIdentity = identity(value.identity, `value inventory source item ${index}.identity`);
  if (!PROVENANCE.has(value.provenance)) throw new TypeError(`value inventory source item ${index}.provenance is invalid`);
  return Object.freeze({
    identity: selectedIdentity,
    provenance: value.provenance,
    protections: identities(value.protections, `value inventory source item ${index}.protections`),
    references: identities(value.references, `value inventory source item ${index}.references`),
    after: identities(value.after, `value inventory source item ${index}.after`),
    value: actionValue(value.value, `value inventory source item ${index}.value`),
  });
}

function sourceObservation(raw, expectedIdentity) {
  const value = exactObject(raw, new Set(['identity', 'generation', 'complete', 'consistent', 'items']), 'value inventory source observation');
  if (value.identity !== expectedIdentity || typeof value.complete !== 'boolean' || typeof value.consistent !== 'boolean'
      || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
    throw new TypeError('value inventory source observation is invalid');
  }
  const items = value.items.map(sourceItem).sort((left, right) => left.identity.localeCompare(right.identity));
  const available = new Set(items.map((entry) => entry.identity));
  if (available.size !== items.length) throw new TypeError('value inventory source items contain duplicates');
  for (const item of items) {
    if (item.after.includes(item.identity) || item.after.some((entry) => !available.has(entry))) {
      throw new TypeError('value inventory source dependency is invalid');
    }
  }
  const visiting = new Set();
  const complete = new Set();
  const byIdentity = new Map(items.map((entry) => [entry.identity, entry]));
  function visit(selectedIdentity) {
    if (complete.has(selectedIdentity)) return;
    if (visiting.has(selectedIdentity)) throw new TypeError('value inventory source dependency graph contains a cycle');
    visiting.add(selectedIdentity);
    for (const dependency of byIdentity.get(selectedIdentity).after) visit(dependency);
    visiting.delete(selectedIdentity);
    complete.add(selectedIdentity);
  }
  for (const selectedIdentity of [...available].sort((left, right) => left.localeCompare(right))) visit(selectedIdentity);
  return Object.freeze({
    identity: expectedIdentity,
    generation: identity(value.generation, 'value inventory source generation'),
    complete: value.complete,
    consistent: value.consistent,
    items: Object.freeze(items),
  });
}

function activityObservation(raw, expectedIdentity) {
  const value = exactObject(raw, new Set(['identity', 'active']), 'value inventory activity observation');
  if (value.identity !== expectedIdentity || typeof value.active !== 'boolean') {
    throw new TypeError('value inventory activity observation is invalid');
  }
  return Object.freeze({ identity: expectedIdentity, active: value.active });
}

function actionObservation(raw, expectedIdentity) {
  const value = exactObject(raw, new Set(['identity', 'state', 'retryable']), 'value inventory action observation');
  if (value.identity !== expectedIdentity || !['present', 'absent', 'ambiguous'].includes(value.state)
      || typeof value.retryable !== 'boolean') {
    throw new TypeError('value inventory action observation is invalid');
  }
  return Object.freeze({ identity: value.identity, state: value.state, retryable: value.retryable });
}

function actionInput(raw) {
  const value = exactObject(raw, new Set(['protocol', 'mode', 'item', 'planDigest', 'effect']), 'value inventory binding input');
  const effect = exactObject(value.effect, new Set(['identity', 'bytes', 'terminal']), 'value inventory binding effect');
  if (typeof value.protocol !== 'string' || value.protocol.length === 0 || value.protocol.length > 256
      || typeof value.mode !== 'string' || !SAFE_ID.test(value.mode)
      || typeof value.item !== 'string' || !SAFE_ID.test(value.item)
      || typeof value.planDigest !== 'string' || !SHA256.test(value.planDigest)
      || typeof effect.identity !== 'string' || !SAFE_ID.test(effect.identity)
      || !Number.isSafeInteger(effect.bytes) || effect.bytes < 0 || effect.terminal !== true) {
    throw new TypeError('value inventory binding input is invalid');
  }
  return Object.freeze({ ...value, effect: Object.freeze({ ...effect }) });
}

function effectIdentity(ownerIdentity, item) {
  return `effect-${digest({ ownerIdentity, itemIdentity: item.identity, value: item.value })}`;
}

function publicItem(ownerIdentity, item, extraProtections = []) {
  return Object.freeze({
    identity: item.identity,
    scope: item.scope,
    provenance: item.provenance,
    protections: identities([...new Set([...item.protections, ...extraProtections])], 'value inventory projected protections'),
    references: item.references,
    after: item.after,
    effects: Object.freeze([Object.freeze({
      identity: effectIdentity(ownerIdentity, item),
      bytes: item.value.bytes,
      terminal: true,
    })]),
  });
}

function storedRecord(raw, ownerIdentity, expectedItem) {
  const value = exactObject(
    raw,
    new Set(['protocol', 'revision', 'phase', 'owner', 'source', 'item', 'plan']),
    'value inventory record',
  );
  if (value.protocol !== EXACT_VALUE_INVENTORY_PROTOCOL || value.owner !== ownerIdentity || !BINDING_PHASES.has(value.phase)
      || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new TypeError('value inventory record identity is invalid');
  }
  const source = exactObject(value.source, new Set(['identity', 'generation', 'complete']), 'value inventory record source');
  if (source.identity !== ownerIdentity || source.complete !== true) throw new TypeError('value inventory record source is invalid');
  const selectedSource = Object.freeze({
    identity: ownerIdentity,
    generation: identity(source.generation, 'value inventory record source generation'),
    complete: true,
  });
  const rawItem = exactObject(
    value.item,
    new Set(['identity', 'scope', 'provenance', 'protections', 'references', 'after', 'value']),
    'value inventory record item',
  );
  const selectedItem = Object.freeze({
    ...sourceItem({
      identity: rawItem.identity,
      provenance: rawItem.provenance,
      protections: rawItem.protections,
      references: rawItem.references,
      after: rawItem.after,
      value: rawItem.value,
    }, 0),
    scope: identity(rawItem.scope, 'value inventory record scope'),
  });
  if (selectedItem.identity !== expectedItem) throw new TypeError('value inventory record item is invalid');
  const plan = actionInput(value.plan);
  const projected = publicItem(ownerIdentity, selectedItem);
  if (plan.item !== expectedItem || !isDeepStrictEqual(plan.effect, projected.effects[0])) {
    throw new TypeError('value inventory record effect changed');
  }
  return Object.freeze({
    protocol: EXACT_VALUE_INVENTORY_PROTOCOL,
    revision: value.revision,
    phase: value.phase,
    owner: ownerIdentity,
    source: selectedSource,
    item: selectedItem,
    plan,
  });
}

function binding(record) {
  return Object.freeze({
    protocol: record.plan.protocol,
    mode: record.plan.mode,
    item: record.plan.item,
    identity: record.plan.effect.identity,
    planDigest: record.plan.planDigest,
    bound: true,
    value: structuredClone(record.item.value),
  });
}

function sameInput(record, input) {
  return record.plan.protocol === input.protocol && record.plan.mode === input.mode && record.plan.item === input.item
    && record.plan.planDigest === input.planDigest && isDeepStrictEqual(record.plan.effect, input.effect);
}

function recordSubject(ownerIdentity, itemIdentity) {
  return `record-${digest({ ownerIdentity, itemIdentity })}`;
}

function withScope(item, scope) {
  return Object.freeze({ ...item, scope });
}

function withoutScope(item) {
  return Object.freeze({
    identity: item.identity,
    provenance: item.provenance,
    protections: item.protections,
    references: item.references,
    after: item.after,
    value: structuredClone(item.value),
  });
}

export function createExactValueInventory({
  identity: rawIdentity,
  scope,
  coverage: rawCoverage,
  source,
  activity,
  records,
  actions,
} = {}) {
  const ownerIdentity = identity(rawIdentity, 'value inventory identity');
  const selectedScope = identity(scope, 'value inventory scope');
  const selectedCoverage = identities(rawCoverage, 'value inventory coverage');
  if (selectedCoverage.length === 0) throw new TypeError('value inventory coverage must not be empty');
  const selectedSource = requirePort(source, ['observe', 'retire'], 'value inventory source');
  const selectedActivity = requirePort(activity, ['observe', 'run'], 'value inventory activity');
  const selectedRecords = requirePort(records, ['run'], 'value inventory records');
  const selectedActions = requirePort(actions, ['observe'], 'value inventory actions');
  const transaction = new AsyncLocalStorage();
  let pending = new Map();

  async function readRecord(itemIdentity) {
    return selectedRecords.run(recordSubject(ownerIdentity, itemIdentity), async (session) => {
      requirePort(session, ['load', 'save'], 'value inventory record session');
      const raw = await session.load();
      return raw == null ? null : storedRecord(raw, ownerIdentity, itemIdentity);
    });
  }

  async function observeSource() {
    return sourceObservation(await selectedSource.observe(Object.freeze({ identity: ownerIdentity })), ownerIdentity);
  }

  async function observeActivity() {
    const observed = activityObservation(await selectedActivity.observe(Object.freeze({ identity: ownerIdentity })), ownerIdentity);
    return transaction.getStore()?.active === true
      ? Object.freeze({ identity: ownerIdentity, active: false })
      : observed;
  }

  async function snapshot() {
    const [before, observedActivity] = await Promise.all([observeSource(), observeActivity()]);
    const recordsByIdentity = new Map(await Promise.all(before.items.map(async (item) => [item.identity, await readRecord(item.identity)])));
    const boundRecords = before.items.map((item) => recordsByIdentity.get(item.identity));
    const allBound = before.items.length > 0 && boundRecords.every((record) => record?.phase === 'bound');
    const boundGenerations = new Set(allBound ? boundRecords.map((record) => record.source.generation) : []);
    if (boundGenerations.size > 1) throw new Error('value inventory bindings disagree on source generation');
    const stableSource = allBound && before.complete
      ? Object.freeze({ ...before, generation: [...boundGenerations][0], consistent: true })
      : before;
    const projected = [];
    const nextPending = new Map();

    for (const rawItem of before.items) {
      const item = withScope(rawItem, selectedScope);
      const record = recordsByIdentity.get(item.identity);
      if (record?.phase === 'bound') {
        if ((!allBound && record.source.generation !== before.generation) || !isDeepStrictEqual(record.item, item)) {
          throw new Error('value inventory source changed after durable binding');
        }
        projected.push(publicItem(ownerIdentity, record.item));
        continue;
      }
      if (record?.phase === 'retired' && record.source.generation === before.generation) {
        throw new Error('value inventory retired source generation remains active');
      }
      if (!stableSource.complete || !stableSource.consistent || observedActivity.active) {
        projected.push(publicItem(ownerIdentity, item));
        continue;
      }
      const observed = actionObservation(await selectedActions.observe(structuredClone(item.value)), item.value.identity);
      const extra = observed.state === 'ambiguous' ? [AMBIGUOUS_PROTECTION] : [];
      projected.push(publicItem(ownerIdentity, item, extra));
      if (observed.state !== 'ambiguous') nextPending.set(item.identity, Object.freeze({ source: before, item }));
    }

    if (stableSource.complete && stableSource.consistent && !observedActivity.active) {
      const [after, afterActivity] = await Promise.all([observeSource(), observeActivity()]);
      if (!isDeepStrictEqual(after, before) || afterActivity.active) {
        throw new Error('value inventory source changed during observation');
      }
    }
    pending = nextPending;
    const fragment = Object.freeze({
      generation: `generation-${digest({ ownerIdentity, source: stableSource, active: observedActivity.active, items: projected })}`,
      coverage: stableSource.complete && stableSource.consistent ? selectedCoverage : Object.freeze([]),
      mutationActive: observedActivity.active,
      protectedReferences: Object.freeze([]),
      items: Object.freeze(projected.sort((left, right) => left.identity.localeCompare(right.identity))),
    });
    return fragment;
  }

  async function bindAction(rawInput) {
    const input = actionInput(rawInput);
    let current = await readRecord(input.item);
    if (current?.phase === 'bound') {
      if (sameInput(current, input)) return binding(current);
      throw new Error('value inventory binding conflicts with durable evidence');
    }
    if (!pending.has(input.item)) await snapshot();
    const selected = pending.get(input.item);
    if (!selected) throw new Error('value inventory binding is not currently available');
    const [observedSource, observedActivity, observedAction] = await Promise.all([
      observeSource(),
      observeActivity(),
      selectedActions.observe(structuredClone(selected.item.value))
        .then((entry) => actionObservation(entry, selected.item.value.identity)),
    ]);
    if (!isDeepStrictEqual(observedSource, selected.source) || observedActivity.active
        || observedAction.state === 'ambiguous') {
      throw new Error('value inventory binding changed before acceptance');
    }
    const expectedEffect = publicItem(ownerIdentity, selected.item).effects[0];
    if (!isDeepStrictEqual(input.effect, expectedEffect)) throw new Error('value inventory binding changed after observation');

    return selectedRecords.run(recordSubject(ownerIdentity, input.item), async (session) => {
      requirePort(session, ['load', 'save'], 'value inventory record session');
      const raw = await session.load();
      current = raw == null ? null : storedRecord(raw, ownerIdentity, input.item);
      if (current?.phase === 'bound') {
        if (sameInput(current, input)) return binding(current);
        throw new Error('value inventory binding conflicts with durable evidence');
      }
      if (current?.phase === 'retired' && current.source.generation === selected.source.generation) {
        throw new Error('value inventory retired source generation cannot be rebound');
      }
      const next = storedRecord({
        protocol: EXACT_VALUE_INVENTORY_PROTOCOL,
        revision: (current?.revision ?? 0) + 1,
        phase: 'bound',
        owner: ownerIdentity,
        source: { identity: ownerIdentity, generation: selected.source.generation, complete: true },
        item: selected.item,
        plan: input,
      }, ownerIdentity, input.item);
      await session.save(next);
      return binding(next);
    });
  }

  async function loadAction(rawInput) {
    const input = actionInput(rawInput);
    const current = await readRecord(input.item);
    if (!current || !sameInput(current, input)) throw new Error('value inventory binding is unavailable');
    return binding(current);
  }

  async function retireAction(rawInput) {
    const input = actionInput(rawInput);
    let current = await readRecord(input.item);
    if (!current || !sameInput(current, input)) throw new Error('value inventory retirement binding is unavailable');
    if (current.phase === 'retired') return Object.freeze({ identity: input.effect.identity, retired: true });
    if (transaction.getStore()?.active !== true) {
      throw new Error('value inventory retirement requires an active transaction');
    }
    const observed = actionObservation(await selectedActions.observe(structuredClone(current.item.value)), current.item.value.identity);
    if (observed.state !== 'absent') throw new Error('value inventory retirement requires exact action absence');
    const expectedItem = withoutScope(current.item);
    const latestSource = await observeSource();
    const latestItem = latestSource.items.find((item) => item.identity === current.item.identity) ?? null;
    if (latestItem && !isDeepStrictEqual(latestItem, expectedItem)) {
      throw new Error('value inventory retirement source item changed');
    }
    const retired = await selectedSource.retire(Object.freeze({
      identity: ownerIdentity,
      generation: latestItem ? latestSource.generation : current.source.generation,
      item: latestItem ?? expectedItem,
    }));
    if (!retired || retired.identity !== current.item.identity || retired.retired !== true || typeof retired.absent !== 'boolean') {
      throw new TypeError('value inventory source retirement result is invalid');
    }
    return selectedRecords.run(recordSubject(ownerIdentity, input.item), async (session) => {
      requirePort(session, ['load', 'save'], 'value inventory record session');
      const raw = await session.load();
      current = raw == null ? null : storedRecord(raw, ownerIdentity, input.item);
      if (!current || !sameInput(current, input)) throw new Error('value inventory retirement binding changed');
      if (current.phase === 'retired') return Object.freeze({ identity: input.effect.identity, retired: true });
      const next = storedRecord({ ...current, revision: current.revision + 1, phase: 'retired' }, ownerIdentity, input.item);
      await session.save(next);
      return Object.freeze({ identity: input.effect.identity, retired: true });
    });
  }

  async function run(operation) {
    if (typeof operation !== 'function') throw new TypeError('value inventory operation must be a function');
    return selectedActivity.run(Object.freeze({ identity: ownerIdentity }), async () => {
      const owner = { active: true };
      return transaction.run(owner, async () => {
        try { return await operation(); }
        finally { owner.active = false; }
      });
    });
  }

  return Object.freeze({ identity: ownerIdentity, snapshot, bind: bindAction, load: loadAction, retire: retireAction, run });
}
