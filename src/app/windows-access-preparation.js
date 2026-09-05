const DESTINATION = 'C:\\ProgramData\\DevBridge\\access\\seed.json';

function sameConnection(left, right) {
  return left?.family === 'windows'
    && right?.family === 'windows'
    && left.username === right.username
    && left.password === right.password;
}

function accessTarget(value) {
  if (typeof value !== 'string' || !/^env-[a-f0-9]{32}$/u.test(value)) throw new TypeError('access preparation target is invalid');
  return value;
}

export function createWindowsAccessPreparation({ material, seed, delivery, probe, settleMs = 90_000, pollMs = 1_000, now = Date.now, wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)) } = {}) {
  if (!material || typeof material.ensure !== 'function' || typeof material.resolve !== 'function') throw new TypeError('access material contract is incomplete');
  if (!seed || typeof seed.create !== 'function') throw new TypeError('access seed contract is incomplete');
  if (!delivery || typeof delivery.put !== 'function') throw new TypeError('access delivery contract is incomplete');
  if (!probe || typeof probe.inspect !== 'function') throw new TypeError('access probe contract is incomplete');
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new TypeError('access settling policy is invalid');
  if (typeof now !== 'function' || typeof wait !== 'function') throw new TypeError('access timing contract is invalid');

  const connection = async (rawTarget) => {
    const target = accessTarget(rawTarget);
    const admitted = await material.ensure(target);
    const resolved = await material.resolve(target);
    if (admitted?.identity !== target || admitted.user !== resolved?.user || typeof resolved?.secret !== 'string') {
      throw new Error('access material identity changed');
    }
    return Object.freeze({ family: 'windows', username: resolved.user, password: resolved.secret });
  };

  const ensure = async ({ target: rawTarget, access } = {}) => {
    const target = accessTarget(rawTarget);
    if (!access || access.family !== 'windows') throw new TypeError('access preparation requires a Windows connection');
    const expected = await connection(target);
    if (!sameConnection(expected, access)) throw new Error('access preparation connection changed');
    let observed = await probe.inspect({ target, connection: access });
    if (observed?.ready === true) return Object.freeze({ ready: true, changed: false });

    const prepared = await seed.create({ target, user: expected.username, secret: expected.password });
    if (!prepared || typeof prepared.file !== 'string' || typeof prepared.cleanup !== 'function') throw new Error('access seed evidence is invalid');
    try {
      await delivery.put(target, prepared.file, DESTINATION);
      const deadline = now() + settleMs;
      do {
        observed = await probe.inspect({ target, connection: access });
        if (observed?.ready === true) return Object.freeze({ ready: true, changed: true });
        if (now() >= deadline) break;
        await wait(pollMs);
      } while (true);
      throw new Error('access did not become ready before its bounded deadline');
    } finally {
      await prepared.cleanup();
    }
  };

  return Object.freeze({ connection, ensure });
}
