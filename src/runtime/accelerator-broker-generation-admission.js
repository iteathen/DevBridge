function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains an unknown field`);
  return value;
}

function cancellationSignal(value) {
  if (value == null) return null;
  if (typeof value !== 'object'
    || typeof value.aborted !== 'boolean'
    || typeof value.addEventListener !== 'function'
    || typeof value.removeEventListener !== 'function') {
    throw new TypeError('accelerator broker generation admission signal is invalid');
  }
  return value;
}

function request(raw) {
  const value = exactObject(raw, new Set(['mode', 'signal']), 'accelerator broker generation admission request');
  if (!['shared', 'exclusive'].includes(value.mode)) throw new TypeError('accelerator broker generation admission mode is invalid');
  return Object.freeze({ mode: value.mode, signal: cancellationSignal(value.signal) });
}

export function createAcceleratorBrokerGenerationAdmission() {
  let activeReaders = 0;
  let activeWriter = false;
  const queue = [];

  const lease = (mode) => {
    let released = false;
    return Object.freeze({
      mode,
      release() {
        if (released) return;
        released = true;
        if (mode === 'shared') {
          if (activeReaders < 1) throw new Error('accelerator broker generation shared admission ownership is inconsistent');
          activeReaders -= 1;
        } else {
          if (!activeWriter) throw new Error('accelerator broker generation exclusive admission ownership is inconsistent');
          activeWriter = false;
        }
        drain();
      },
    });
  };

  const settle = (entry, value) => {
    if (entry.settled) return;
    entry.settled = true;
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.resolve(value);
  };

  const grantShared = (entry) => {
    activeReaders += 1;
    settle(entry, lease('shared'));
  };

  const grantExclusive = (entry) => {
    activeWriter = true;
    settle(entry, lease('exclusive'));
  };

  function drain() {
    if (activeWriter || queue.length === 0) return;
    while (queue.length > 0 && queue[0].settled) queue.shift();
    if (queue.length === 0) return;
    if (queue[0].mode === 'exclusive') {
      if (activeReaders !== 0) return;
      const entry = queue.shift();
      grantExclusive(entry);
      return;
    }
    while (queue.length > 0 && queue[0].mode === 'shared' && !activeWriter) {
      const entry = queue.shift();
      if (entry.settled) continue;
      grantShared(entry);
    }
  }

  const queuedAcquire = (input) => new Promise((resolve) => {
    const entry = {
      mode: input.mode,
      signal: input.signal,
      resolve,
      settled: false,
      onAbort: null,
    };
    entry.onAbort = () => {
      settle(entry, null);
      drain();
    };
    queue.push(entry);
    input.signal?.addEventListener('abort', entry.onAbort, { once: true });
    if (input.signal?.aborted) entry.onAbort();
    else drain();
  });

  return Object.freeze({
    async acquire(rawRequest) {
      const input = request(rawRequest);
      if (input.signal?.aborted) return null;
      if (input.mode === 'shared' && !activeWriter && queue.length === 0) {
        activeReaders += 1;
        return lease('shared');
      }
      if (input.mode === 'exclusive' && !activeWriter && activeReaders === 0 && queue.length === 0) {
        activeWriter = true;
        return lease('exclusive');
      }
      return queuedAcquire(input);
    },
  });
}
