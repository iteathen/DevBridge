import net from 'node:net';

const WINDOWS_PIPE = /^\\\\\.\\pipe\\/iu;
const WINDOWS_TRANSIENT_OPEN_CODES = new Set(['EBUSY', 'ENOENT']);
const RETRY_DELAY_MS = 25;
export const LOCAL_AUTHORITY_RESPONSE_ACKNOWLEDGEMENT = 'devbridge/local-authority-response-ack-v1\n';

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

export function transactAcknowledgedLocalAuthorityJsonLine({
  socket,
  request,
  maxRequestWireBytes,
  maxResponseWireBytes,
  authority,
  failure,
  signal = null,
  responseTimeoutMs = null,
} = {}) {
  if (!socket || typeof socket.on !== 'function' || typeof socket.once !== 'function'
      || typeof socket.write !== 'function' || typeof socket.end !== 'function') {
    throw new TypeError('local authority response socket is invalid');
  }
  if (!Number.isSafeInteger(maxRequestWireBytes) || maxRequestWireBytes < 1
      || !Number.isSafeInteger(maxResponseWireBytes) || maxResponseWireBytes < 1) {
    throw new TypeError('local authority response bounds are invalid');
  }
  if (typeof authority !== 'string' || authority.length === 0 || typeof failure !== 'function') {
    throw new TypeError('local authority response composition is invalid');
  }
  if (responseTimeoutMs != null && (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1)) {
    throw new TypeError('local authority response timeout is invalid');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let acknowledged = false;
    let buffer = '';
    let parsed;
    let responseComplete = false;
    let responseTimer = null;
    const fail = (message) => failure(`${authority} ${message}`);
    const onAbort = () => finish(fail('exchange was interrupted'));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (responseTimer != null) clearTimeout(responseTimer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const completeResponse = () => {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return null;
      if (buffer.slice(newline + 1).trim() !== '') {
        finish(fail('response framing is invalid'));
        return null;
      }
      if (!responseComplete) {
        try { parsed = JSON.parse(buffer.slice(0, newline)); }
        catch {
          finish(fail('response is malformed'));
          return null;
        }
        responseComplete = true;
      }
      if (!acknowledged) {
        acknowledged = true;
        try { socket.end(LOCAL_AUTHORITY_RESPONSE_ACKNOWLEDGEMENT); }
        catch (error) {
          error.localAuthorityResponseBytes = Buffer.byteLength(buffer, 'utf8');
          finish(error);
          return null;
        }
      }
      return true;
    };
    const acceptResponse = () => {
      if (settled) return;
      const complete = completeResponse();
      if (settled) return;
      if (!complete) {
        const error = fail('closed without a result');
        error.localAuthorityResponseBytes = Buffer.byteLength(buffer, 'utf8');
        error.localAuthorityTerminal = 'disconnect';
        return finish(error);
      }
      finish(null, parsed);
    };
    if (signal?.aborted) return finish(fail('exchange was interrupted'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (responseTimeoutMs != null) {
      responseTimer = setTimeout(() => finish(fail('exchange timed out')), responseTimeoutMs);
      responseTimer.unref?.();
    }
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > maxResponseWireBytes) {
        finish(fail('response exceeded the transport bound'));
        return;
      }
      completeResponse();
    });
    socket.once('end', acceptResponse);
    socket.once('error', (error) => {
      if (buffer.includes('\n')) return acceptResponse();
      error.localAuthorityResponseBytes = Buffer.byteLength(buffer, 'utf8');
      finish(error);
    });
    socket.once('close', acceptResponse);
    let wire;
    try { wire = `${JSON.stringify(request)}\n`; }
    catch { return finish(fail('request could not be encoded')); }
    if (Buffer.byteLength(wire, 'utf8') > maxRequestWireBytes) return finish(fail('request exceeded the transport bound'));
    socket.write(wire);
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
  let replayConnectionDeadline = null;
  for (;;) {
    const remaining = replayConnectionDeadline == null ? selectedTimeout : replayConnectionDeadline - now();
    if (remaining <= 0) throw connectionFailure('local authority re-arm timed out', 'ETIMEDOUT');
    const socket = await connectBoundedLocalAuthoritySocket({
      endpoint: selectedEndpoint,
      timeoutMs: remaining,
      signal,
    }, dependencies);
    const transactionStarted = now();
    let retry = false;
    try {
      return await transact(socket);
    } catch (error) {
      retry = replaySafe === true
        && WINDOWS_PIPE.test(selectedEndpoint)
        && error?.localAuthorityResponseBytes === 0
        && (error?.code === 'EPIPE' || error?.localAuthorityTerminal === 'disconnect');
      if (!retry) throw error;
      const transactionFinished = now();
      if (replayConnectionDeadline == null) replayConnectionDeadline = transactionFinished + selectedTimeout;
      else replayConnectionDeadline += Math.max(0, transactionFinished - transactionStarted);
      const retryRemaining = replayConnectionDeadline - transactionFinished;
      if (retryRemaining <= 0) throw error;
    } finally {
      socket.destroy();
    }
    if (retry) {
      const retryRemaining = replayConnectionDeadline - now();
      if (retryRemaining <= 0) throw connectionFailure('local authority re-arm timed out', 'ETIMEDOUT');
      await wait(Math.min(RETRY_DELAY_MS, retryRemaining), signal);
    }
  }
}
