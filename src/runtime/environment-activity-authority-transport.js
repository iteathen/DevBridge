import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { transactBoundedLocalAuthoritySocket } from './local-authority-socket-connection.js';
import {
  ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_REQUEST_BYTES,
  ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_RESULT_BYTES,
  EnvironmentActivityClient,
  createEnvironmentActivityHandler,
} from './environment-activity-authority.js';

const AUTHORITY_ID = /^[0-9a-f]{32}$/u;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const MAX_REQUEST_WIRE_BYTES = ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_REQUEST_BYTES + 1024;
const MAX_RESULT_WIRE_BYTES = ENVIRONMENT_ACTIVITY_AUTHORITY_MAX_RESULT_BYTES + 1024;

function platformPath(platform) {
  if (platform === 'win32') return path.win32;
  if (platform === 'linux') return path.posix;
  throw new Error(`environment activity authority is unsupported on platform ${String(platform)}`);
}

export function environmentActivityAuthorityIdentity(stateDirectory, { platform = process.platform } = {}) {
  const localPath = platformPath(platform);
  if (typeof stateDirectory !== 'string' || !localPath.isAbsolute(stateDirectory)) throw new TypeError('environment activity authority state directory must be absolute');
  let normalized = localPath.resolve(stateDirectory);
  if (platform === 'win32') normalized = normalized.toLowerCase();
  return createHash('sha256')
    .update('devbridge/environment-activity-authority-v1\0', 'utf8')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function authorityIdentity(value) {
  if (typeof value !== 'string' || !AUTHORITY_ID.test(value)) throw new TypeError('environment activity authority identity is invalid');
  return value;
}

export function environmentActivityAuthorityEndpoint({
  authorityIdentity: rawIdentity,
  platform = process.platform,
  runDirectory = '/run/devbridge',
} = {}) {
  const identity = authorityIdentity(rawIdentity);
  platformPath(platform);
  if (platform === 'win32') return `\\\\.\\pipe\\devbridge-environment-${identity}-activity-v1`;
  return path.posix.join(runDirectory, identity, 'activity', 'environment-v1.sock');
}

function connectTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) throw new TypeError('environment activity connect timeout must be 100-30000 ms');
  return value;
}

function operationTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 300_000) throw new TypeError('environment activity operation timeout must be 100-300000 ms');
  return value;
}

function transportFailure(message = 'environment activity authority transport is unavailable') {
  const error = new Error(message);
  error.code = 'ENVIRONMENT_ACTIVITY_AUTHORITY_UNAVAILABLE';
  return error;
}

export function createEnvironmentActivitySocketExchange({
  endpoint,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  exchangeTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
} = {}) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw new TypeError('environment activity authority endpoint is required');
  const connectMs = connectTimeout(connectTimeoutMs);
  const exchangeMs = operationTimeout(exchangeTimeoutMs);
  return async (request, { signal = null } = {}) => {
    try {
      return await transactBoundedLocalAuthoritySocket({
        endpoint,
        timeoutMs: connectMs,
        signal,
        inspection: request?.operation === 'inspect',
        transact: (socket) => new Promise((resolve, reject) => {
          let settled = false;
          let buffer = '';
          let exchangeTimer = null;
          const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (exchangeTimer != null) clearTimeout(exchangeTimer);
            signal?.removeEventListener?.('abort', onAbort);
            if (error) reject(error); else resolve(value);
          };
          const onAbort = () => finish(transportFailure('environment activity authority exchange was interrupted'));
          if (signal?.aborted) return finish(transportFailure('environment activity authority exchange was interrupted'));
          signal?.addEventListener?.('abort', onAbort, { once: true });
          socket.setEncoding('utf8');
          exchangeTimer = setTimeout(() => finish(transportFailure('environment activity authority exchange timed out')), exchangeMs);
          exchangeTimer.unref?.();
          const acceptResponse = () => {
            if (settled) return;
            const newline = buffer.indexOf('\n');
            if (newline < 0) return finish(transportFailure('environment activity authority closed without a result'));
            if (buffer.slice(newline + 1).trim() !== '') return finish(transportFailure('environment activity authority response framing is invalid'));
            let response;
            try { response = JSON.parse(buffer.slice(0, newline)); }
            catch { return finish(transportFailure('environment activity authority response is malformed')); }
            finish(null, response);
          };
          socket.on('data', (chunk) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer, 'utf8') > MAX_RESULT_WIRE_BYTES) finish(transportFailure('environment activity authority response exceeded the transport bound'));
          });
          socket.once('end', acceptResponse);
          socket.once('error', (error) => {
            if (buffer.includes('\n')) return acceptResponse();
            error.localAuthorityResponseBytes = Buffer.byteLength(buffer, 'utf8');
            finish(error);
          });
          socket.once('close', () => { if (!settled) finish(transportFailure('environment activity authority connection closed ambiguously')); });
          let wire;
          try { wire = `${JSON.stringify(request)}\n`; }
          catch { return finish(transportFailure('environment activity authority request could not be encoded')); }
          if (Buffer.byteLength(wire, 'utf8') > MAX_REQUEST_WIRE_BYTES) return finish(transportFailure('environment activity authority request exceeded the transport bound'));
          socket.write(wire);
        }),
      });
    } catch (error) {
      if (error?.code === 'ENVIRONMENT_ACTIVITY_AUTHORITY_UNAVAILABLE') throw error;
      throw transportFailure(signal?.aborted
        ? 'environment activity authority exchange was interrupted'
        : 'environment activity authority transport is unavailable');
    }
  };
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    const cleanup = () => { server.off('error', onError); server.off('listening', onListening); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function createEnvironmentActivitySocketServerAtEndpoint({
  endpoint,
  handler,
  maxConnections = 32,
  requestTimeoutMs = 5000,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
} = {}) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw new TypeError('environment activity authority endpoint is required');
  if (typeof handler !== 'function') throw new TypeError('environment activity authority handler is required');
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 256) throw new TypeError('environment activity authority maxConnections is invalid');
  const preRequestTimeoutMs = connectTimeout(requestTimeoutMs);
  const operationMs = operationTimeout(operationTimeoutMs);
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let processing = false;
    let answered = false;
    let controller = null;
    let operationTimer = null;
    const clearOperationTimer = () => {
      if (operationTimer == null) return;
      clearTimeout(operationTimer);
      operationTimer = null;
    };
    const failClosed = () => {
      if (answered) return;
      answered = true;
      clearOperationTimer();
      controller?.abort();
      socket.destroy();
    };
    socket.setTimeout(preRequestTimeoutMs, failClosed);
    const answer = (value) => {
      if (answered) return;
      let wire;
      try { wire = `${JSON.stringify(value)}\n`; } catch { return failClosed(); }
      if (Buffer.byteLength(wire, 'utf8') > MAX_RESULT_WIRE_BYTES) return failClosed();
      answered = true;
      clearOperationTimer();
      socket.end(wire);
    };
    socket.on('data', async (chunk) => {
      if (answered) return;
      if (processing) return failClosed();
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_WIRE_BYTES) return failClosed();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim() !== '') return failClosed();
      let request;
      try { request = JSON.parse(buffer.slice(0, newline)); } catch { return failClosed(); }
      processing = true;
      controller = new AbortController();
      socket.setTimeout(0);
      const onClose = () => failClosed();
      socket.once('close', onClose);
      operationTimer = setTimeout(failClosed, operationMs);
      operationTimer.unref?.();
      try { answer(await handler(request, { signal: controller.signal })); } catch { failClosed(); }
      finally {
        clearOperationTimer();
        socket.off('close', onClose);
      }
    });
    socket.once('error', failClosed);
  });
  server.maxConnections = maxConnections;
  return Object.freeze({
    endpoint,
    async start() { await listen(server, endpoint); return this; },
    async close() { await close(server); },
  });
}

function endpointFor({ stateDirectory, platform, runDirectory }) {
  const identity = environmentActivityAuthorityIdentity(stateDirectory, { platform });
  return Object.freeze({
    identity,
    endpoint: environmentActivityAuthorityEndpoint({ authorityIdentity: identity, platform, runDirectory }),
  });
}

export function createConfiguredEnvironmentActivityClient({
  stateDirectory,
  platform = process.platform,
  runDirectory = '/run/devbridge',
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  exchangeTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
} = {}) {
  const selected = endpointFor({ stateDirectory, platform, runDirectory });
  return new EnvironmentActivityClient({
    exchange: createEnvironmentActivitySocketExchange({
      endpoint: selected.endpoint,
      connectTimeoutMs,
      exchangeTimeoutMs,
    }),
  });
}

export function createEnvironmentActivitySocketServer({
  activity,
  stateDirectory,
  platform = process.platform,
  runDirectory = '/run/devbridge',
  requestTimeoutMs = 5000,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
} = {}) {
  const selected = endpointFor({ stateDirectory, platform, runDirectory });
  return createEnvironmentActivitySocketServerAtEndpoint({
    endpoint: selected.endpoint,
    handler: createEnvironmentActivityHandler({ activity }),
    requestTimeoutMs,
    operationTimeoutMs,
  });
}
