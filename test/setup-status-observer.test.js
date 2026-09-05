import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSetupStatusObserver } from '../src/setup/status-observer.js';

test('setup observer reports configured ready execution without acquiring setup authority', async () => {
  let calls = 0;
  const observer = createSetupStatusObserver({
    configuredSubjectCount: 3,
    enabled: true,
    inspectCapability: () => {
      calls += 1;
      return { state: 'ready', ready: true, identity: 'local-only', reason: null };
    },
  });

  const result = await observer.observe();
  assert.equal(calls, 1);
  assert.equal(result.protocol, 'devbridge/status-observation-v1');
  assert.equal(result.state, 'ready');
  assert.equal(result.enabled, true);
  assert.equal(result.configuredCount, 3);
  assert.deepEqual(result.capability, { state: 'ready', ready: true, reason: null });
  assert.equal(JSON.stringify(result).includes('local-only'), false);
});

test('setup observer reports unavailable opted-in capability', async () => {
  const observer = createSetupStatusObserver({
    configuredSubjectCount: 2,
    enabled: true,
    inspectCapability: () => ({ state: 'unavailable', ready: false, identity: null, reason: 'environment boundary is unavailable' }),
  });

  const result = await observer.observe();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.enabled, true);
  assert.equal(result.capability.reason, 'environment boundary is unavailable');
});

test('setup observer distinguishes local opt-out from capability failure', async () => {
  const observer = createSetupStatusObserver({
    configuredSubjectCount: 1,
    enabled: false,
    inspectCapability: () => ({ state: 'unavailable', ready: false, identity: null, reason: 'no boundary is attached' }),
  });

  const result = await observer.observe();
  assert.equal(result.state, 'disabled');
  assert.equal(result.enabled, false);
  assert.equal(result.capability.ready, false);
});

test('setup observer rejects inconsistent observations instead of inventing readiness', async () => {
  const observer = createSetupStatusObserver({
    configuredSubjectCount: 0,
    enabled: true,
    inspectCapability: () => ({ state: 'ready', ready: false, reason: 'contradictory' }),
  });
  await assert.rejects(() => observer.observe(), /inconsistent/u);
});

test('setup observer rejects unbounded or control-bearing reasons', async () => {
  for (const reason of ['line one\nline two', 'x'.repeat(1_025)]) {
    const observer = createSetupStatusObserver({
      configuredSubjectCount: 0,
      enabled: true,
      inspectCapability: () => ({ state: 'unavailable', ready: false, reason }),
    });
    await assert.rejects(() => observer.observe(), /requires a reason/u);
  }
});

test('setup observer source has no effect-bearing dependencies or methods', async () => {
  const source = await readFile(new URL('../src/setup/status-observer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/mu);
  assert.doesNotMatch(source, /\.(?:reconcile|install|construct|activate|publish|download|elevat|write|save|set)\w*\s*\(/iu);
});
