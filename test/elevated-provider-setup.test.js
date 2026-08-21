import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureWindowsFoundationNetwork,
  launchElevatedProviderHelper,
  PROVIDER_ELEVATION_JOURNAL_PROTOCOL,
  PROVIDER_ELEVATION_OPERATION,
  PROVIDER_ELEVATION_RESULT_PROTOCOL,
  providerElevationResultFile,
  providerElevationRoot,
  runElevatedProviderRequest,
} from '../src/bootstrap/elevated-provider-setup.mjs';

const IDENTITY = 'a'.repeat(32);

function outputPort({ tty = false } = {}) {
  let text = '';
  return { isTTY: tty, write(value) { text += String(value); }, get text() { return text; } };
}

function foundationStatus({ networking = false, management = true } = {}) {
  const capability = (ready, reason) => ({ state: ready ? 'ready' : 'degraded', ready, reason: ready ? null : reason });
  return {
    protocol: 'devbridge/environment-foundation-status-v1',
    state: networking && management ? 'ready' : 'degraded',
    ready: networking && management,
    identity: IDENTITY,
    reason: networking && management ? null : 'fixture degraded',
    capabilities: {
      management: capability(management, 'management unavailable'),
      images: capability(true),
      networking: capability(networking, 'owned network is absent'),
      storage: capability(true),
    },
  };
}

function prepareState() {
  const stateDirectory = path.join(mkdtempSync(path.join(tmpdir(), 'devbridge-uac-provider-')), 'state');
  const foundationRoot = path.join(stateDirectory, 'environment-foundation');
  mkdirSync(foundationRoot, { recursive: true });
  writeFileSync(path.join(foundationRoot, 'identity.json'), `${JSON.stringify({
    protocol: 'devbridge/local-foundation-identity-v1',
    token: IDENTITY,
  })}\n`);
  return stateDirectory;
}

function fakeElevatedLaunch({ state, foundationFactory } = {}) {
  return async ({ requestFile, requestSha256 }) => {
    await runElevatedProviderRequest(requestFile, requestSha256, { foundationFactory });
    state.launches += 1;
    return { started: true, pid: 1234 };
  };
}

test('bounded elevated network setup writes an exact request, verifies the result unelevated, and reconciles its journal', async () => {
  const stateDirectory = prepareState();
  const state = { ready: false, launches: 0 };
  const foundation = { async inspect() { return foundationStatus({ networking: state.ready }); } };
  const elevatedFoundation = {
    async inspect() { return foundationStatus({ networking: state.ready }); },
    async ensureNetwork() { state.ready = true; },
  };
  const output = outputPort();
  const result = await ensureWindowsFoundationNetwork({
    stateDirectory,
    foundation,
    output,
    allowElevation: true,
    launch: fakeElevatedLaunch({ state, foundationFactory: async () => elevatedFoundation }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(state.launches, 1);
  assert.match(output.text, /Verified the exact DevBridge-owned Hyper-V switch/u);

  const root = providerElevationRoot(stateDirectory);
  const journal = JSON.parse(readFileSync(path.join(root, 'journal.json'), 'utf8'));
  assert.equal(journal.protocol, PROVIDER_ELEVATION_JOURNAL_PROTOCOL);
  assert.equal(journal.operation, PROVIDER_ELEVATION_OPERATION);
  assert.equal(journal.phase, 'reconciled');
  const requestFile = path.join(root, 'requests', `${journal.requestId}.json`);
  const requestBytes = readFileSync(requestFile);
  assert.equal(createHash('sha256').update(requestBytes).digest('hex'), journal.requestSha256);
  const elevatedResult = JSON.parse(readFileSync(providerElevationResultFile(requestFile), 'utf8'));
  assert.equal(elevatedResult.protocol, PROVIDER_ELEVATION_RESULT_PROTOCOL);
  assert.equal(elevatedResult.requestSha256, journal.requestSha256);
  assert.equal(elevatedResult.foundationIdentity, IDENTITY);
  assert.equal(elevatedResult.status, 'succeeded');
});

test('setup requires a local ELEVATE confirmation before Windows displays its second UAC prompt', async () => {
  const stateDirectory = prepareState();
  const state = { ready: false, launches: 0 };
  const foundation = { async inspect() { return foundationStatus({ networking: state.ready }); } };
  const elevatedFoundation = {
    async inspect() { return foundationStatus({ networking: state.ready }); },
    async ensureNetwork() { state.ready = true; },
  };
  const input = { isTTY: true };
  const output = outputPort({ tty: true });
  const answers = ['yes', 'ELEVATE'];
  const promptFactory = () => ({
    async question(message) { output.write(message); return answers.shift(); },
    close() {},
  });
  await ensureWindowsFoundationNetwork({
    stateDirectory,
    foundation,
    input,
    output,
    promptFactory,
    launch: fakeElevatedLaunch({ state, foundationFactory: async () => elevatedFoundation }),
  });
  assert.equal(state.launches, 1);
  assert.match(output.text, /Only the fixed environment-foundation\.ensure-network operation/u);
  assert.match(output.text, /Invalid elevation selection/u);
  assert.equal([...output.text.matchAll(/Type ELEVATE/gu)].length, 2);
});

test('declined UAC launch records failure and never runs provider mutation', async () => {
  const stateDirectory = prepareState();
  let ready = false;
  const foundation = { async inspect() { return foundationStatus({ networking: ready }); } };
  await assert.rejects(
    ensureWindowsFoundationNetwork({
      stateDirectory,
      foundation,
      output: outputPort(),
      allowElevation: true,
      launch: async () => ({ started: false, reason: 'UAC elevation was declined or could not be started' }),
    }),
    /declined or could not be started/u,
  );
  assert.equal(ready, false);
  const journal = JSON.parse(readFileSync(path.join(providerElevationRoot(stateDirectory), 'journal.json'), 'utf8'));
  assert.equal(journal.phase, 'failed');
});

test('a forged elevated result is rejected before it can create readiness', async () => {
  const stateDirectory = prepareState();
  const foundation = { async inspect() { return foundationStatus({ networking: false }); } };
  await assert.rejects(
    ensureWindowsFoundationNetwork({
      stateDirectory,
      foundation,
      output: outputPort(),
      allowElevation: true,
      launch: async ({ requestFile, requestSha256 }) => {
        mkdirSync(path.dirname(providerElevationResultFile(requestFile)), { recursive: true });
        const request = JSON.parse(readFileSync(requestFile, 'utf8'));
        writeFileSync(providerElevationResultFile(requestFile), `${JSON.stringify({
          protocol: PROVIDER_ELEVATION_RESULT_PROTOCOL,
          requestId: request.requestId,
          requestSha256,
          operation: PROVIDER_ELEVATION_OPERATION,
          foundationIdentity: 'b'.repeat(32),
          status: 'succeeded',
          networkingReady: true,
          completedAt: new Date().toISOString(),
          reason: null,
        })}\n`);
        return { started: true, pid: 4321 };
      },
    }),
    /subject does not match/u,
  );
});

test('an interrupted elevation is recovered by exact provider observation on setup re-entry', async () => {
  const stateDirectory = prepareState();
  let ready = false;
  let launches = 0;
  const foundation = { async inspect() { return foundationStatus({ networking: ready }); } };
  await assert.rejects(
    ensureWindowsFoundationNetwork({
      stateDirectory,
      foundation,
      output: outputPort(),
      allowElevation: true,
      waitMs: 5,
      launch: async () => { launches += 1; return { started: true, pid: 9876 }; },
    }),
    /did not return a result/u,
  );
  ready = true;
  const output = outputPort();
  const recovered = await ensureWindowsFoundationNetwork({
    stateDirectory,
    foundation,
    output,
    launch: async () => { launches += 1; return { started: true, pid: 9877 }; },
  });
  assert.equal(recovered.recovered, true);
  assert.equal(launches, 1);
  assert.match(output.text, /Recovered the previous elevated Hyper-V network request/u);
  const journal = JSON.parse(readFileSync(path.join(providerElevationRoot(stateDirectory), 'journal.json'), 'utf8'));
  assert.equal(journal.phase, 'reconciled');
  assert.equal(journal.recoveredByObservation, true);
});

test('network elevation is refused when ordinary DevBridge Hyper-V management is unavailable', async () => {
  const stateDirectory = prepareState();
  let launched = false;
  await assert.rejects(
    ensureWindowsFoundationNetwork({
      stateDirectory,
      foundation: { async inspect() { return foundationStatus({ networking: false, management: false }); } },
      output: outputPort(),
      allowElevation: true,
      launch: async () => { launched = true; return { started: true, pid: 1 }; },
    }),
    /ordinary DevBridge account/u,
  );
  assert.equal(launched, false);
});

test('UAC launcher requests runas for a hidden fixed helper and strips credential-shaped environment values', async () => {
  let captured = null;
  const result = await launchElevatedProviderHelper({
    requestFile: 'C:\\Users\\Example User\\.devbridge\\state\\environment-foundation\\setup-elevation\\requests\\request.json',
    requestSha256: 'c'.repeat(64),
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    helperFile: 'C:\\Users\\Example User\\DevBridge\\src\\bootstrap\\elevated-provider-setup.mjs',
    invoke: async (request) => {
      captured = request;
      return { exitCode: 0, timedOut: false, aborted: false, outputTruncated: false, stdout: '{"started":true,"pid":2468}\n', stderr: '' };
    },
  });
  assert.deepEqual(result, { started: true, pid: 2468 });
  const script = Buffer.from(captured.arguments.at(-1), 'base64').toString('utf16le');
  assert.match(script, /-Verb RunAs/u);
  assert.match(script, /-WindowStyle Hidden/u);
  assert.match(captured.input, /--devbridge-elevated-provider-request/u);
  assert.match(captured.input, /"C:\\\\Program Files\\\\nodejs\\\\node\.exe"/u);
  assert.equal(captured.environment.GH_TOKEN, undefined);
  assert.equal(captured.environment.GITHUB_TOKEN, undefined);
  assert.equal(captured.environment.SSH_AUTH_SOCK, undefined);
});

test('elevated helper rejects a changed request before composing provider authority', async () => {
  const stateDirectory = prepareState();
  const root = providerElevationRoot(stateDirectory);
  const requestId = '12345678-1234-4123-8123-123456789abc';
  const requestFile = path.join(root, 'requests', `${requestId}.json`);
  mkdirSync(path.dirname(requestFile), { recursive: true });
  writeFileSync(requestFile, `${JSON.stringify({
    protocol: 'devbridge/provider-setup-elevation-request-v1',
    requestId,
    operation: PROVIDER_ELEVATION_OPERATION,
    stateDirectory,
    foundationIdentity: IDENTITY,
    requestedAt: new Date().toISOString(),
  })}\n`);
  let composed = false;
  await assert.rejects(
    runElevatedProviderRequest(requestFile, 'd'.repeat(64), {
      foundationFactory: async () => { composed = true; return null; },
    }),
    /digest does not match/u,
  );
  assert.equal(composed, false);
});
