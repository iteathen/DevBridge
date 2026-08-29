import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {
  ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_REQUEST_BYTES,
  ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_RESULT_BYTES,
  EnvironmentConfigurationClient,
  createEnvironmentConfigurationHandler,
} from './environment-configuration-authority.js';

const AUTHORITY_ID = /^[0-9a-f]{32}$/u;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const MAX_REQUEST_WIRE_BYTES = ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_REQUEST_BYTES + 1024;
const MAX_RESULT_WIRE_BYTES = ENVIRONMENT_CONFIGURATION_AUTHORITY_MAX_RESULT_BYTES + 1024;

function platformPath(platform) {
  if (platform === 'win32') return path.win32;
  if (platform === 'linux') return path.posix;
  throw new Error(`environment configuration authority is unsupported on platform ${String(platform)}`);
}

export function environmentConfigurationAuthorityIdentity(stateDirectory, { platform = process.platform } = {}) {
  const localPath = platformPath(platform);
  if (typeof stateDirectory !== 'string' || !localPath.isAbsolute(stateDirectory)) throw new TypeError('environment configuration authority state directory must be absolute');
  let normalized = localPath.resolve(stateDirectory);
  if (platform === 'win32') normalized = normalized.toLowerCase();
  return createHash('sha256')
    .update('devbridge/environment-configuration-authority-v1\0', 'utf8')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function identity(value) {
  if (typeof value !== 'string' || !AUTHORITY_ID.test(value)) throw new TypeError('environment configuration authority identity is invalid');
  return value;
}

export function environmentConfigurationAuthorityEndpoint({
  authorityIdentity,
  platform = process.platform,
  runDirectory = '/run/devbridge',
} = {}) {
  const selected = identity(authorityIdentity);
  platformPath(platform);
  if (platform === 'win32') return `\\\\.\\pipe\\devbridge-environment-${selected}-configuration-v1`;
  return path.posix.join(runDirectory, selected, 'configuration', 'environment-v1.sock');
}

function timeout(value) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) throw new TypeError('environment configuration connect timeout must be 100-30000 ms');
  return value;
}

function unavailable(message = 'environment configuration authority transport is unavailable') {
  const error = new Error(message);
  error.code = 'ENVIRONMENT_CONFIGURATION_AUTHORITY_UNAVAILABLE';
  return error;
}

export function createEnvironmentConfigurationSocketExchange({ endpoint, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw new TypeError('environment configuration authority endpoint is required');
  const timeoutMs = timeout(connectTimeoutMs);
  return async (request) => new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    const socket = net.createConnection(endpoint);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(unavailable()), timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      clearTimeout(timer);
      let wire;
      try { wire = `${JSON.stringify(request)}\n`; }
      catch { return finish(unavailable('environment configuration request could not be encoded')); }
      if (Buffer.byteLength(wire, 'utf8') > MAX_REQUEST_WIRE_BYTES) return finish(unavailable('environment configuration request exceeded the transport bound'));
      socket.write(wire);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESULT_WIRE_BYTES) return finish(unavailable('environment configuration response exceeded the transport bound'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim() !== '') return finish(unavailable('environment configuration response framing is invalid'));
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); }
      catch { return finish(unavailable('environment configuration response is malformed')); }
      finish(null, response);
    });
    socket.once('end', () => { if (!settled) finish(unavailable('environment configuration authority closed without a result')); });
    socket.once('error', () => finish(unavailable()));
    socket.once('close', () => { if (connected && !settled) finish(unavailable('environment configuration authority connection closed ambiguously')); });
  });
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

export function createEnvironmentConfigurationSocketServerAtEndpoint({ endpoint, handler, maxConnections = 8, requestTimeoutMs = 5000 } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw new TypeError('environment configuration authority endpoint is required');
  if (typeof handler !== 'function') throw new TypeError('environment configuration authority handler is required');
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 32) throw new TypeError('environment configuration authority maxConnections is invalid');
  const timeoutMs = timeout(requestTimeoutMs);
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let processing = false;
    let answered = false;
    const failClosed = () => {
      if (answered) return;
      answered = true;
      socket.destroy();
    };
    socket.setTimeout(timeoutMs, failClosed);
    const answer = (value) => {
      if (answered) return;
      let wire;
      try { wire = `${JSON.stringify(value)}\n`; } catch { return failClosed(); }
      if (Buffer.byteLength(wire, 'utf8') > MAX_RESULT_WIRE_BYTES) return failClosed();
      answered = true;
      socket.end(wire);
    };
    socket.on('data', async (chunk) => {
      if (processing || answered) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_WIRE_BYTES) return failClosed();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim() !== '') return failClosed();
      let request;
      try { request = JSON.parse(buffer.slice(0, newline)); } catch { return failClosed(); }
      processing = true;
      socket.setTimeout(0);
      socket.pause();
      try { answer(await handler(request)); } catch { failClosed(); }
    });
    socket.once('error', () => {});
  });
  server.maxConnections = maxConnections;
  return Object.freeze({
    endpoint,
    async start() { await listen(server, endpoint); return this; },
    async close() { await close(server); },
  });
}

function endpointFor({ stateDirectory, platform, runDirectory }) {
  const authorityIdentity = environmentConfigurationAuthorityIdentity(stateDirectory, { platform });
  return environmentConfigurationAuthorityEndpoint({ authorityIdentity, platform, runDirectory });
}

export function createConfiguredEnvironmentConfigurationClient({
  stateDirectory,
  platform = process.platform,
  runDirectory = '/run/devbridge',
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  const endpoint = endpointFor({ stateDirectory, platform, runDirectory });
  return new EnvironmentConfigurationClient({ exchange: createEnvironmentConfigurationSocketExchange({ endpoint, connectTimeoutMs }) });
}

export function createEnvironmentConfigurationSocketServer({
  configuration,
  stateDirectory,
  platform = process.platform,
  runDirectory = '/run/devbridge',
} = {}) {
  const endpoint = endpointFor({ stateDirectory, platform, runDirectory });
  return createEnvironmentConfigurationSocketServerAtEndpoint({
    endpoint,
    handler: createEnvironmentConfigurationHandler({ configuration }),
  });
}
