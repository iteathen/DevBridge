import { setTimeout as delay } from 'node:timers/promises';

const DESTINATION = '/var/lib/devbridge/access/seed.json';

function sameConnection(left, right) {
  return left?.family === 'linux' && right?.family === 'linux' && left.user === right.user && left.identityFile === right.identityFile && left.knownHostsFile === right.knownHostsFile;
}

export function createLinuxAccessPreparation({ material, delivery, probe, settleMs = 180_000, pollMs = 1_000, now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  if (!material || typeof material.connection !== 'function' || typeof material.prepare !== 'function') throw new TypeError('Linux access material contract is incomplete');
  if (!delivery || typeof delivery.put !== 'function') throw new TypeError('Linux access delivery contract is incomplete');
  if (!probe || typeof probe.inspect !== 'function') throw new TypeError('Linux access probe contract is incomplete');
  if (!Number.isSafeInteger(settleMs) || settleMs < 100 || settleMs > 300_000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 30_000
    || typeof now !== 'function' || typeof wait !== 'function') throw new TypeError('Linux access settling policy is invalid');

  const connection = (target) => material.connection(target);
  const ensure = async ({ target, access, deadline = null, signal = undefined }) => {
    if (!access || access.family !== 'linux') throw new TypeError('Linux access preparation requires a Linux connection');
    const expected = connection(target);
    if (!sameConnection(expected, access)) throw new Error('Linux access preparation connection changed');
    if (deadline != null && !Number.isSafeInteger(deadline)) throw new TypeError('Linux access deadline is invalid');
    const until = Math.min(now() + settleMs, deadline ?? Infinity);
    let observed;
    const remaining = () => {
      signal?.throwIfAborted();
      const value = until - now();
      if (value < 100) throw new Error(`Linux access did not become ready before its deadline: ${observed?.reason ?? 'starting'}`);
      return value;
    };
    const inspect = async () => {
      observed = await probe.inspect(access, { timeoutMs: Math.min(15_000, remaining()), signal });
      remaining();
      return observed;
    };
    await inspect();
    if (observed.ready === true) return Object.freeze({ ready: true, changed: false });

    const prepared = await material.prepare(target);
    try {
      if (!sameConnection(prepared.connection, access)) throw new Error('Linux access material returned another connection identity');
      await delivery.put(target, prepared.seedFile, DESTINATION, { timeoutMs: Math.min(30_000, remaining()), signal });
      do {
        await inspect();
        if (observed.ready === true) return Object.freeze({ ready: true, changed: true });
        await wait(Math.min(pollMs, remaining()), signal);
      } while (true);
    } finally {
      await prepared.cleanup();
    }
  };

  return Object.freeze({ connection, ensure });
}
