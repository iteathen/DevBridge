const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function boundedValue(value, name) {
  if (typeof value !== 'string' || !SAFE_VALUE.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function cancellationSignal(value) {
  if (value == null) return null;
  if (typeof value !== 'object'
    || typeof value.aborted !== 'boolean'
    || typeof value.addEventListener !== 'function'
    || typeof value.removeEventListener !== 'function') {
    throw new TypeError('activity gate cancellation signal is invalid');
  }
  return value;
}

function request(value, { identity }) {
  const allowed = identity
    ? new Set(['subject', 'operationId', 'signal'])
    : new Set(['signal']);
  const selected = exactObject(value ?? {}, allowed, 'activity gate request');
  return Object.freeze({
    ...(identity ? {
      subject: boundedValue(selected.subject, 'activity gate subject'),
      operationId: boundedValue(selected.operationId, 'activity gate operationId'),
    } : {}),
    signal: cancellationSignal(selected.signal),
  });
}

function record(value, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const selected = exactObject(value, new Set(['subject', 'operationId']), 'activity gate intent record');
  return Object.freeze({
    subject: boundedValue(selected.subject, 'activity gate intent subject'),
    operationId: boundedValue(selected.operationId, 'activity gate intent operationId'),
  });
}

function sameRecord(left, right) {
  return left.subject === right.subject && left.operationId === right.operationId;
}

function acquiredLease(value) {
  if (value == null) return null;
  const selected = exactObject(value, new Set(['release']), 'activity gate lease');
  if (typeof selected.release !== 'function') throw new TypeError('activity gate lease release port is invalid');
  return selected;
}

function intentPort(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.observe !== 'function'
    || typeof value.ensure !== 'function'
    || typeof value.clear !== 'function') {
    throw new TypeError(`activity gate ${name} intent contract is incomplete`);
  }
  return value;
}

function requirePorts({ sharedIntent, exclusiveIntent, lease } = {}) {
  const shared = intentPort(sharedIntent, 'shared');
  const exclusive = intentPort(exclusiveIntent, 'exclusive');
  if (!lease || typeof lease !== 'object' || Array.isArray(lease) || typeof lease.acquire !== 'function') {
    throw new TypeError('activity gate lease contract is incomplete');
  }
  return Object.freeze({ sharedIntent: shared, exclusiveIntent: exclusive, lease });
}

async function releaseAfterFailure(selected) {
  try { await selected.release(); }
  catch { /* Preserve the primary admission failure. */ }
}

export function createActivityGate(ports = {}) {
  const selected = requirePorts(ports);

  return Object.freeze({
    shared: Object.freeze({
      async reconcile(rawRequest = {}) {
        request(rawRequest, { identity: false });
        const observed = record(await selected.sharedIntent.observe(), { nullable: true });
        if (observed == null) return false;
        const cleared = await selected.sharedIntent.clear(observed);
        if (cleared !== true) throw new Error('activity gate shared intent was not reconciled exactly');
        if (record(await selected.sharedIntent.observe(), { nullable: true }) != null) {
          throw new Error('activity gate shared intent remained after reconciliation');
        }
        return true;
      },
      async acquire(rawRequest) {
        const input = request(rawRequest, { identity: true });
        const expected = Object.freeze({ subject: input.subject, operationId: input.operationId });
        if (input.signal?.aborted) return null;
        if (record(await selected.exclusiveIntent.observe(), { nullable: true }) != null) return null;

        const ensured = record(await selected.sharedIntent.ensure(expected));
        if (!sameRecord(ensured, expected)) throw new Error('activity gate shared intent changed during publication');

        const held = acquiredLease(await selected.lease.acquire(Object.freeze({ mode: 'shared', signal: input.signal })));
        if (held == null) {
          const cleared = await selected.sharedIntent.clear(expected);
          if (cleared !== true) throw new Error('activity gate shared intent was not cleared after refusal');
          return null;
        }
        try {
          const own = record(await selected.sharedIntent.observe());
          const peer = record(await selected.exclusiveIntent.observe(), { nullable: true });
          if (!sameRecord(own, expected) || peer != null) {
            await held.release();
            const cleared = await selected.sharedIntent.clear(expected);
            if (cleared !== true) throw new Error('activity gate shared intent was not cleared after refusal');
            return null;
          }
          let lockHeld = true;
          let cleared = false;
          return Object.freeze({
            subject: expected.subject,
            operationId: expected.operationId,
            async release() {
              if (!cleared) {
                const result = await selected.sharedIntent.clear(expected);
                if (result !== true) throw new Error('activity gate shared intent was not cleared exactly');
                cleared = true;
              }
              if (!lockHeld) return;
              await held.release();
              lockHeld = false;
            },
          });
        } catch (error) {
          await releaseAfterFailure(held);
          throw error;
        }
      },
    }),
    exclusive: Object.freeze({
      async acquire(rawRequest) {
        const input = request(rawRequest, { identity: true });
        const expected = Object.freeze({ subject: input.subject, operationId: input.operationId });
        if (input.signal?.aborted) throw new Error('activity gate exclusive lease is unavailable');
        const ensured = record(await selected.exclusiveIntent.ensure(expected));
        if (!sameRecord(ensured, expected)) throw new Error('activity gate exclusive intent changed during publication');

        const held = acquiredLease(await selected.lease.acquire(Object.freeze({ mode: 'exclusive', signal: input.signal })));
        if (held == null) throw new Error('activity gate exclusive lease is unavailable');
        let lockHeld = true;
        let cleared = false;
        try {
          const own = record(await selected.exclusiveIntent.observe());
          const peer = record(await selected.sharedIntent.observe(), { nullable: true });
          if (!sameRecord(own, expected)) throw new Error('activity gate exclusive intent changed during admission');
          if (peer != null) throw new Error('activity gate shared activity remains after exclusive admission');
        } catch (error) {
          await releaseAfterFailure(held);
          throw error;
        }

        return Object.freeze({
          subject: expected.subject,
          operationId: expected.operationId,
          async release() {
            if (!cleared) {
              const result = await selected.exclusiveIntent.clear(expected);
              if (result !== true) throw new Error('activity gate exclusive intent was not cleared exactly');
              cleared = true;
            }
            if (!lockHeld) return;
            await held.release();
            lockHeld = false;
          },
        });
      },
    }),
  });
}
