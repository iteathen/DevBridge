import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DEFINITION_OBSERVATION_PROTOCOL,
  DEFINITION_RECONCILIATION_PROTOCOL,
  reconcileDefinition,
} from '../src/setup/definition-reconciliation.js';

const DEFINITION = '[Local]\nValue=exact\n';

function fixture(initial = {}, { interrupt = null, distort = null } = {}) {
  const state = { stored: false, current: false, persistent: false, ...initial };
  const calls = [];
  const observe = async ({ definition }) => {
    assert.equal(definition, DEFINITION);
    calls.push('observe');
    return {
      protocol: DEFINITION_OBSERVATION_PROTOCOL,
      ...state,
      ...(typeof distort === 'function' ? distort(calls, state) : {}),
    };
  };
  const effect = (name, property) => async (request) => {
    assert.equal(request.definition, DEFINITION);
    calls.push(name);
    state[property] = true;
    if (interrupt === name) throw new Error(`interrupted after ${name}`);
    return true;
  };
  return {
    state,
    calls,
    ports: {
      observe,
      publish: effect('publish', 'stored'),
      refresh: effect('refresh', 'current'),
      persist: effect('persist', 'persistent'),
    },
  };
}

test('fresh definition reaches exact durable readiness in dependency order', async () => {
  const values = fixture();
  const result = await reconcileDefinition({ definition: DEFINITION, ports: values.ports });
  assert.deepEqual(result, { protocol: DEFINITION_RECONCILIATION_PROTOCOL, ready: true, changed: true });
  assert.deepEqual(values.state, { stored: true, current: true, persistent: true });
  assert.deepEqual(values.calls, ['observe', 'publish', 'observe', 'refresh', 'observe', 'persist', 'observe']);
});

test('exact ready definition is a true effect-free no-op', async () => {
  const values = fixture({ stored: true, current: true, persistent: true });
  const result = await reconcileDefinition({ definition: DEFINITION, ports: values.ports });
  assert.deepEqual(result, { protocol: DEFINITION_RECONCILIATION_PROTOCOL, ready: true, changed: false });
  assert.deepEqual(values.calls, ['observe']);
});

test('interruption after every effect resumes from observation without replaying completed work', async () => {
  for (const selected of ['publish', 'refresh', 'persist']) {
    const values = fixture({}, { interrupt: selected });
    await assert.rejects(() => reconcileDefinition({ definition: DEFINITION, ports: values.ports }), new RegExp(`interrupted after ${selected}`, 'u'));
    const firstCount = values.calls.filter((entry) => entry === selected).length;
    const resumed = await reconcileDefinition({ definition: DEFINITION, ports: {
      ...values.ports,
      [selected]: async () => { throw new Error(`${selected} replayed`); },
    } });
    assert.equal(resumed.ready, true);
    assert.equal(resumed.changed, selected !== 'persist');
    assert.equal(values.calls.filter((entry) => entry === selected).length, firstCount);
  }
});

test('inexact post-effect state and invalid action evidence fail closed', async () => {
  const changedNeighbor = fixture({}, {
    distort(calls) {
      if (calls.filter((entry) => entry === 'observe').length === 2) return { current: true };
      return {};
    },
  });
  await assert.rejects(
    () => reconcileDefinition({ definition: DEFINITION, ports: changedNeighbor.ports }),
    /publish postcondition is inexact/u,
  );

  const invalidEvidence = fixture();
  invalidEvidence.ports.publish = async () => false;
  await assert.rejects(
    () => reconcileDefinition({ definition: DEFINITION, ports: invalidEvidence.ports }),
    /publish action evidence is invalid/u,
  );
});

test('impossible, widened, and malformed contracts are rejected before effects', async () => {
  const impossible = fixture({ stored: false, current: true });
  await assert.rejects(
    () => reconcileDefinition({ definition: DEFINITION, ports: impossible.ports }),
    /impossible without stored bytes/u,
  );
  assert.deepEqual(impossible.calls, ['observe']);

  const widenedObservation = fixture();
  widenedObservation.ports.observe = async () => ({
    protocol: DEFINITION_OBSERVATION_PROTOCOL,
    stored: false,
    current: false,
    persistent: false,
    command: 'forbidden',
  });
  await assert.rejects(
    () => reconcileDefinition({ definition: DEFINITION, ports: widenedObservation.ports }),
    /unknown field/u,
  );

  await assert.rejects(
    () => reconcileDefinition({ definition: `${DEFINITION}\0`, ports: fixture().ports }),
    /definition is invalid/u,
  );
  await assert.rejects(
    () => reconcileDefinition({ definition: DEFINITION, ports: { ...fixture().ports, provider: () => {} } }),
    /unknown field/u,
  );
  await assert.rejects(
    () => reconcileDefinition({ definition: DEFINITION, ports: fixture().ports, service: 'foreign' }),
    /unknown field/u,
  );
});

test('generic definition owner contains no platform or neighboring topology identity', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/setup/definition-reconciliation.js', import.meta.url)), 'utf8');
  for (const forbidden of ['Linux', 'Windows', 'systemd', 'systemctl', 'serviceName', 'unitName', 'filesystemPath', 'provider', 'repository', 'virtualMachine', 'lifecycle']) {
    assert.equal(source.includes(forbidden), false, `definition owner gained neighboring identity through ${forbidden}`);
  }
});
