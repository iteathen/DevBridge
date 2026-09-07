const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const MAX_ITEMS = 1_024;
const MAX_REASON = 512;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function items(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS) throw new TypeError('serial reconciliation items are invalid');
  const values = raw.map((value, index) => {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`serial reconciliation items[${index}] is invalid`);
    return value;
  });
  if (new Set(values).size !== values.length) throw new TypeError('serial reconciliation items contain duplicates');
  return Object.freeze(values);
}

function observation(raw) {
  const value = exactObject(raw, new Set(['ready', 'changed', 'blocker']), 'serial reconciliation observation');
  if (typeof value.ready !== 'boolean' || typeof value.changed !== 'boolean') throw new TypeError('serial reconciliation observation state is invalid');
  const blocker = value.blocker == null ? null : value.blocker;
  if (blocker != null && (typeof blocker !== 'string' || blocker.length < 1 || blocker.length > MAX_REASON || /[\0\r\n]/u.test(blocker))) {
    throw new TypeError('serial reconciliation observation blocker is invalid');
  }
  if (value.ready === (blocker != null)) throw new TypeError('serial reconciliation observation blocker is inconsistent');
  return Object.freeze({ ready: value.ready, changed: value.changed, blocker });
}

function result({ ready, changed, state, item = null, completedCount, totalCount, blocker = null }) {
  return Object.freeze({ ready, changed, state, item, completedCount, totalCount, blocker });
}

export async function reconcileSerialSelection({ items: rawItems, reconcile } = {}) {
  const selected = items(rawItems);
  if (typeof reconcile !== 'function') throw new TypeError('serial reconciliation contract is incomplete');
  let completedCount = 0;
  for (const item of selected) {
    const observed = observation(await reconcile(item));
    if (!observed.ready) {
      return result({
        ready: false,
        changed: observed.changed,
        state: 'blocked',
        item,
        completedCount,
        totalCount: selected.length,
        blocker: observed.blocker,
      });
    }
    completedCount += 1;
    if (observed.changed) {
      const ready = completedCount === selected.length;
      return result({
        ready,
        changed: true,
        state: ready ? 'ready' : 'pending',
        item,
        completedCount,
        totalCount: selected.length,
      });
    }
  }
  return result({ ready: true, changed: false, state: 'ready', completedCount, totalCount: selected.length });
}
