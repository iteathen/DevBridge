import net from 'node:net';

const WINDOWS_PIPE = /^\\\\\.\\pipe\\/iu;
const WINDOWS_TRANSIENT_OPEN_CODES = new Set(['EBUSY', 'ENOENT']);
const RETRY_DELAY_MS = 25;

function requiredEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('local authority endpoint is required');
  return value;
}

function requiredTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('local authority connect timeout is invalid');
  return value;
}

function connectionFailure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function connectOnce({ endpoint, timeoutMs, signal, createConnection }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      socket?.off?.('connect', onConnect);
      socket?.off?.('error', onError);
      if (error) {
        socket?.destroy?.();
        reject(error);
      } else resolve(socket);
    };
    const onAbort = () => finish(connectionFailure('local authority connection was interrupted', 'ABORT_ERR'));
    const onConnect = () => finish(null);
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(connectionFailure('local authority connection timed out', 'ETIMEDOUT')), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) return finish(connectionFailure('local authority connection was interrupted', 'ABORT_ERR'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      socket = createConnection(endpoint);
      socket.once('connect', onConnect);
      socket.once('error', onError);
    } catch (error) {
      finish(error);
    }
  });
}

function retryDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(connectionFailure('local authority connection was interrupted', 'ABORT_ERR'));
    const timer = setTimeout(() => finish(null), milliseconds);
    if (signal?.aborted) return finish(connectionFailure('local authority connection was interrupted', 'ABORT_ERR'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export async function connectBoundedLocalAuthoritySocket({ endpoint, timeoutMs, signal = null } = {}, {
  createConnection = net.createConnection,
  now = Date.now,
  wait = retryDelay,
} = {}) {
  const selectedEndpoint = requiredEndpoint(endpoint);
  const selectedTimeout = requiredTimeout(timeoutMs);
  if (typeof createConnection !== 'function' || typeof now !== 'function' || typeof wait !== 'function') {
    throw new TypeError('local authority connection composition is invalid');
  }
  const retryable = WINDOWS_PIPE.test(selectedEndpoint);
  const deadline = now() + selectedTimeout;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw connectionFailure('local authority connection timed out', 'ETIMEDOUT');
    try {
      return await connectOnce({ endpoint: selectedEndpoint, timeoutMs: remaining, signal, createConnection });
    } catch (error) {
      if (signal?.aborted || error?.code === 'ABORT_ERR') {
        throw connectionFailure('local authority connection was interrupted', 'ABORT_ERR');
      }
      if (!retryable || !WINDOWS_TRANSIENT_OPEN_CODES.has(error?.code)) throw error;
      const retryRemaining = deadline - now();
      if (retryRemaining <= 0) throw connectionFailure('local authority connection timed out', 'ETIMEDOUT');
      await wait(Math.min(RETRY_DELAY_MS, retryRemaining), signal);
    }
  }
}

export async function transactBoundedLocalAuthoritySocket({
  endpoint,
  timeoutMs,
  signal = null,
  replaySafe = false,
  transact,
} = {}, dependencies = {}) {
  const selectedEndpoint = requiredEndpoint(endpoint);
  const selectedTimeout = requiredTimeout(timeoutMs);
  if (typeof replaySafe !== 'boolean' || typeof transact !== 'function') {
    throw new TypeError('local authority transaction composition is invalid');
  }
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? retryDelay;
  if (typeof now !== 'function' || typeof wait !== 'function') throw new TypeError('local authority transaction timing is invalid');
  const deadline = now() + selectedTimeout;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw connectionFailure('local authority connection timed out', 'ETIMEDOUT');
    const socket = await connectBoundedLocalAuthoritySocket({
      endpoint: selectedEndpoint,
      timeoutMs: remaining,
      signal,
    }, dependencies);
    let retry = false;
    try {
      return await transact(socket);
    } catch (error) {
      retry = replaySafe === true
        && WINDOWS_PIPE.test(selectedEndpoint)
        && error?.code === 'EPIPE'
        && error?.localAuthorityResponseBytes === 0;
      if (!retry) throw error;
      const retryRemaining = deadline - now();
      if (retryRemaining <= 0) throw error;
    } finally {
      socket.destroy();
    }
    if (retry) {
      const retryRemaining = deadline - now();
      if (retryRemaining <= 0) throw connectionFailure('local authority connection timed out', 'ETIMEDOUT');
      await wait(Math.min(RETRY_DELAY_MS, retryRemaining), signal);
    }
  }
}
