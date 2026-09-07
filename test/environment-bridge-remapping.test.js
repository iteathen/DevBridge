import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_BRIDGE_PROTOCOL,
  normalizeEnvironmentBridgeRequest,
  normalizeEnvironmentBridgeResponse,
  rebindEnvironmentBridgeRequest,
  rebindEnvironmentBridgeResponse,
} from '../src/runtime/environment-bridge.js';

const REQUEST = '1'.repeat(32);
const LOGICAL_TARGET = 'environment-logical';
const ATTACHED_TARGET = 'environment-attached';
const PREFIX = 'workspaces/workspace-0123456789abcdef';

function frame(kind, body = {}) {
  return {
    protocol: ENVIRONMENT_BRIDGE_PROTOCOL,
    request: REQUEST,
    target: LOGICAL_TARGET,
    kind,
    body,
  };
}

function result(request, body) {
  return {
    protocol: ENVIRONMENT_BRIDGE_PROTOCOL,
    request: request.request,
    target: request.target,
    kind: request.kind,
    ok: true,
    body,
  };
}

test('bridge request normalization rejects foreign authority and path fields', () => {
  assert.throws(() => normalizeEnvironmentBridgeRequest({ ...frame('health'), provider: 'foreign' }), /provider is not allowed/u);
  assert.throws(() => normalizeEnvironmentBridgeRequest(frame('execute', {
    program: 'node', arguments: [], directory: { class: 'work', path: 'C:/host' }, environment: {}, input: null,
    timeoutMs: 1_000, maxOutputBytes: 4_096,
  })), /portable and relative/u);
  assert.throws(() => normalizeEnvironmentBridgeRequest(frame('put', {
    destination: { class: 'input', path: 'source.c' }, offset: 0, data: '', eof: true,
    digest: 'a'.repeat(64), identityFile: 'C:/secret',
  })), /identityFile is not allowed/u);
});

test('bridge request rebinding changes only the local target and classified locations', () => {
  const original = frame('execute', {
    program: 'node',
    arguments: [
      'agent.mjs',
      { class: 'input', path: 'ports/request' },
      { class: 'output', path: 'ports/result' },
    ],
    directory: { class: 'work', path: '.' },
    environment: { CI: '1' },
    input: null,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
  const rebound = rebindEnvironmentBridgeRequest(original, { target: ATTACHED_TARGET, prefix: PREFIX });
  assert.equal(rebound.target, ATTACHED_TARGET);
  assert.equal(rebound.request, REQUEST);
  assert.equal(rebound.kind, 'execute');
  assert.deepEqual(rebound.body.directory, { class: 'work', path: PREFIX });
  assert.deepEqual(rebound.body.arguments.slice(1), [
    { class: 'input', path: `${PREFIX}/ports/request` },
    { class: 'output', path: `${PREFIX}/ports/result` },
  ]);
  assert.deepEqual(original.body.directory, { class: 'work', path: '.' });
});

test('bridge request rebinding scopes transfer locations and preserves chunk evidence', () => {
  const put = frame('put', {
    destination: { class: 'input', path: 'source/part' }, offset: 16,
    data: Buffer.from('next').toString('base64'), eof: false, digest: null,
  });
  const reboundPut = rebindEnvironmentBridgeRequest(put, { target: ATTACHED_TARGET, prefix: PREFIX });
  assert.deepEqual(reboundPut.body.destination, { class: 'input', path: `${PREFIX}/source/part` });
  assert.equal(reboundPut.body.offset, 16);
  assert.equal(reboundPut.body.data, put.body.data);

  const get = frame('get', { source: { class: 'output', path: 'candidate/part' }, offset: 32, limit: 16_384 });
  const reboundGet = rebindEnvironmentBridgeRequest(get, { target: ATTACHED_TARGET, prefix: PREFIX });
  assert.deepEqual(reboundGet.body.source, { class: 'output', path: `${PREFIX}/candidate/part` });
  assert.equal(reboundGet.body.offset, 32);
  assert.equal(reboundGet.body.limit, 16_384);
});

test('bridge response normalization rejects identity and provider-detail injection', () => {
  const request = normalizeEnvironmentBridgeRequest(frame('health'));
  assert.throws(() => normalizeEnvironmentBridgeResponse({
    ...result(request, { version: '1.0.0', features: ['health', 'execute', 'observe', 'cancel', 'put', 'get'] }),
    target: 'wrong',
  }, request), /identity does not match/u);
  assert.throws(() => normalizeEnvironmentBridgeResponse(result(request, {
    version: '1.0.0', features: ['health'], identityFile: 'C:/secret',
  }), request), /identityFile is not allowed/u);
});

test('bridge response rebinding validates the attached response then restores logical identity', () => {
  const logical = normalizeEnvironmentBridgeRequest(frame('get', {
    source: { class: 'output', path: 'candidate/result' }, offset: 0, limit: 16_384,
  }));
  const attached = rebindEnvironmentBridgeRequest(logical, { target: ATTACHED_TARGET, prefix: PREFIX });
  const bytes = Buffer.from('candidate');
  const attachedResponse = result(attached, {
    offset: 0,
    data: bytes.toString('base64'),
    eof: true,
    digest: 'a'.repeat(64),
  });
  const rebound = rebindEnvironmentBridgeResponse(attachedResponse, { from: attached, to: logical });
  assert.equal(rebound.target, LOGICAL_TARGET);
  assert.equal(rebound.request, REQUEST);
  assert.equal(rebound.kind, 'get');
  assert.equal(rebound.body.data, bytes.toString('base64'));
});

