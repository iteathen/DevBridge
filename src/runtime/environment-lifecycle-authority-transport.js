import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {
  ENVIRONMENT_LIFECYCLE_AUTHORITY_MAX_ENVELOPE_BYTES,
  LifecycleAuthorityClient,
  createLifecycleAuthorityMutationHandler,
  createLifecycleAuthorityReadHandler,
} from './environment-lifecycle-authority.js';

const AUTHORITY_ID = /^[0-9a-f]{32}$/u;
const ACCESS_CLASSES = new Set(['read', 'mutation']);
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const MAX_WIRE_BYTES = ENVIRONMENT_LIFECYCLE_AUTHORITY_MAX_ENVELOPE_BYTES + 1024;

function platformPath(platform) {
  if (platform === 'win32') return path.win32;
  if (platform === 'linux') return path.posix;
  throw new Error(`environment lifecycle authority is unsupported on platform ${String(platform)}`);
}

export function environmentLifecycleAuthorityIdentity(stateDirectory, { platform = process.platform } = {}) {
  const localPath = platformPath(platform);
  if (typeof stateDirectory !== 'string' || !localPath.isAbsolute(stateDirectory)) {
    throw new TypeError('environment lifecycle authority state directory must be absolute');
  }
  let normalized = localPath.resolve(stateDirectory);
  if (platform === 'win32') normalized = normalized.toLowerCase();
  return createHash('sha256')
    .update('devbridge/environment-lifecycle-authority-v1\0', 'utf8')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function validateAuthorityIdentity(value) {
  if (typeof value !== 'string' || !AUTHORITY_ID.test(value)) throw new TypeError('environment lifecycle authority identity is invalid');
  return value;
}

function validateAccess(value) {
  if (typeof value !== 'string' || !ACCESS_CLASSES.has(value)) throw new TypeError('lifecycle authority access class is invalid');
  return value;
}

export function environmentLifecycleAuthorityEndpoint({
  authorityIdentity,
  access,
  platform = process.platform,
  runDirectory = '/run/devbridge',
} = {}) {
  const identity = validateAuthorityIdentity(authorityIdentity);
  const selected = validateAccess(access);
  platformPath(platform);
  if (platform === 'win32') return `\\\\.\\pipe\\devbridge-environment-${identity}-${selected}-v1`;
  return path.posix.join(runDirectory, identity, `environment-${selected}-v1.sock`);
}

function transportFailure(message = 'environment lifecycle authority transport is unavailable') {
  const error = new Error(message);
  error.code = 'LIFECYCLE_AUTHORITY_UNAVAILABLE';
  return error;
}

function validateConnectTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new TypeError('lifecycle authority connect timeout must be 100-30000 ms');
  }
  return value;
}

export function createLifecycleAuthoritySocketExchange({ endpoint, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw new TypeError('lifecycle authority endpoint is required');
  const timeoutMs = validateConnectTimeout(connectTimeoutMs);
  return async (request) => new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    const socket = net.createConnection(endpoint);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const connectTimer = setTimeout(() => finish(transportFailure()), timeoutMs);
    connectTimer.unref?.();
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      let wire;
      try { wire = `${JSON.stringify(request)}\n`; }
      catch { return finish(transportFailure('environment lifecycle authority request could not be encoded')); }
      if (Buffer.byteLength(wire, 'utf8') > MAX_WIRE_BYTES) return finish(transportFailure('environment lifecycle authority request exceeded the transport bound'));
      socket.write(wire);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_WIRE_BYTES) return finish(transportFailure('environment lifecycle authority response exceeded the transport bound'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim() !== '') return finish(transportFailure('environment lifecycle authority response framing is invalid'));
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); }
      catch { return finish(transportFailure('environment lifecycle authority response is malformed')); }
      finish(null, response);
    });
    socket.once('end', () => {
      if (!settled) finish(transportFailure('environment lifecycle authority closed without a result'));
    });
    socket.once('error', () => finish(transportFailure()));
    socket.once('close', () => {
      if (connected && !settled) finish(transportFailure('environment lifecycle authority connection closed ambiguously'));
    });
  });
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
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

export function createLifecycleAuthoritySocketServer({ endpoint, handler, maxConnections = 32 } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) throw new TypeError('lifecycle authority endpoint is required');
  if (typeof handler !== 'function') throw new TypeError('lifecycle authority handler is required');
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 256) throw new TypeError('lifecycle authority maxConnections is invalid');

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
    const answer = (value) => {
      if (answered) return;
      let wire;
      try { wire = `${JSON.stringify(value)}\n`; }
      catch { return failClosed(); }
      if (Buffer.byteLength(wire, 'utf8') > MAX_WIRE_BYTES) return failClosed();
      answered = true;
      socket.end(wire);
    };
    socket.on('data', async (chunk) => {
      if (processing || answered) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_WIRE_BYTES) return failClosed();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (buffer.slice(newline + 1).trim() !== '') return failClosed();
      let request;
      try { request = JSON.parse(buffer.slice(0, newline)); }
      catch { return failClosed(); }
      processing = true;
      socket.pause();
      try { answer(await handler(request)); }
      catch { failClosed(); }
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

function authorityEndpoints({ stateDirectory, platform, runDirectory }) {
  const authorityIdentity = environmentLifecycleAuthorityIdentity(stateDirectory, { platform });
  return Object.freeze({
    authorityIdentity,
    read: environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'read', platform, runDirectory }),
    mutation: environmentLifecycleAuthorityEndpoint({ authorityIdentity, access: 'mutation', platform, runDirectory }),
  });
}

export function createConfiguredLifecycleAuthorityClient({
  stateDirectory,
  platform = process.platform,
  runDirectory = '/run/devbridge',
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  const endpoints = authorityEndpoints({ stateDirectory, platform, runDirectory });
  return new LifecycleAuthorityClient({
    readExchange: createLifecycleAuthoritySocketExchange({ endpoint: endpoints.read, connectTimeoutMs }),
    mutationExchange: createLifecycleAuthoritySocketExchange({ endpoint: endpoints.mutation, connectTimeoutMs }),
  });
}

export function createLifecycleAuthoritySocketServers({
  operator,
  stateDirectory,
  platform = process.platform,
  runDirectory = '/run/devbridge',
} = {}) {
  const endpoints = authorityEndpoints({ stateDirectory, platform, runDirectory });
  return Object.freeze({
    authorityIdentity: endpoints.authorityIdentity,
    read: createLifecycleAuthoritySocketServer({ endpoint: endpoints.read, handler: createLifecycleAuthorityReadHandler({ operator }) }),
    mutation: createLifecycleAuthoritySocketServer({ endpoint: endpoints.mutation, handler: createLifecycleAuthorityMutationHandler({ operator }) }),
  });
}
