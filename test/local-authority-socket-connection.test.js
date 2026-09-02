import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  connectBoundedLocalAuthoritySocket,
  transactBoundedLocalAuthoritySocket,
} from '../src/runtime/local-authority-socket-connection.js';

function connectionFactory(codes) {
  let attempts = 0;
  return Object.freeze({
    attempts: () => attempts,
    createConnection() {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      const code = codes[attempts] ?? null;
      attempts += 1;
      queueMicrotask(() => {
        if (code == null) socket.emit('connect');
        else socket.emit('error', Object.assign(new Error(code), { code }));
      });
      return socket;
    },
  });
}

test('Windows local authority connection retries only transient pipe-open failures', async () => {
  const fixture = connectionFactory(['ENOENT', 'EBUSY', null]);
  const socket = await connectBoundedLocalAuthoritySocket({ endpoint: '\\\\.\\pipe\\devbridge-test', timeoutMs: 1000 }, {
    createConnection: fixture.createConnection,
    wait: async () => {},
  });
  assert.equal(socket instanceof EventEmitter, true);
  assert.equal(fixture.attempts(), 3);
});

test('local authority connection never retries denial or Linux socket absence', async () => {
  const denied = connectionFactory(['EACCES', null]);
  await assert.rejects(
    connectBoundedLocalAuthoritySocket({ endpoint: '\\\\.\\pipe\\devbridge-test', timeoutMs: 1000 }, {
      createConnection: denied.createConnection,
      wait: async () => {},
    }),
    (error) => error?.code === 'EACCES',
  );
  assert.equal(denied.attempts(), 1);

  const absent = connectionFactory(['ENOENT', null]);
  await assert.rejects(
    connectBoundedLocalAuthoritySocket({ endpoint: '/run/devbridge/test.sock', timeoutMs: 1000 }, {
      createConnection: absent.createConnection,
      wait: async () => {},
    }),
    (error) => error?.code === 'ENOENT',
  );
  assert.equal(absent.attempts(), 1);
});

test('Windows transient retries remain inside the original connection deadline', async () => {
  const fixture = connectionFactory(['ENOENT', null]);
  const observations = [0, 0, 0, 100];
  await assert.rejects(
    connectBoundedLocalAuthoritySocket({ endpoint: '\\\\.\\pipe\\devbridge-test', timeoutMs: 100 }, {
      createConnection: fixture.createConnection,
      now: () => observations.shift() ?? 100,
      wait: async () => {},
    }),
    (error) => error?.code === 'ETIMEDOUT',
  );
  assert.equal(fixture.attempts(), 1);
});

test('Windows replay-safe operation retries only stale zero-response transactions', async () => {
  const fixture = connectionFactory([null, null]);
  let transactions = 0;
  const value = await transactBoundedLocalAuthoritySocket({
    endpoint: '\\\\.\\pipe\\devbridge-test',
    timeoutMs: 1000,
    replaySafe: true,
    transact: async () => {
      transactions += 1;
      if (transactions === 1) throw Object.assign(new Error('stale pipe'), { code: 'EPIPE', localAuthorityResponseBytes: 0 });
      return 'ready';
    },
  }, {
    createConnection: fixture.createConnection,
    wait: async () => {},
  });
  assert.equal(value, 'ready');
  assert.equal(transactions, 2);
});

test('late Windows zero-response replay receives one fresh bounded connection window', async () => {
  const fixture = connectionFactory([null, 'ENOENT', null]);
  let clock = 0;
  let transactions = 0;
  const value = await transactBoundedLocalAuthoritySocket({
    endpoint: '\\\\.\\pipe\\devbridge-test',
    timeoutMs: 1000,
    replaySafe: true,
    transact: async () => {
      transactions += 1;
      if (transactions === 1) {
        clock = 5000;
        throw Object.assign(new Error('late stale pipe'), { code: 'EPIPE', localAuthorityResponseBytes: 0 });
      }
      return 'ready';
    },
  }, {
    createConnection: fixture.createConnection,
    now: () => clock,
    wait: async () => {},
  });
  assert.equal(value, 'ready');
  assert.equal(transactions, 2);
  assert.equal(fixture.attempts(), 3);
});

test('replayed Windows transactions do not spend the bounded connection re-arm budget', async () => {
  const fixture = connectionFactory([null, null, null]);
  let clock = 0;
  let transactions = 0;
  const value = await transactBoundedLocalAuthoritySocket({
    endpoint: '\\\\.\\pipe\\devbridge-test',
    timeoutMs: 1000,
    replaySafe: true,
    transact: async () => {
      transactions += 1;
      if (transactions === 3) return 'ready';
      clock += 5000;
      throw Object.assign(new Error('persistently stale pipe'), { code: 'EPIPE', localAuthorityResponseBytes: 0 });
    },
  }, {
    createConnection: fixture.createConnection,
    now: () => clock,
    wait: async () => { clock += 25; },
  });
  assert.equal(value, 'ready');
  assert.equal(transactions, 3);
  assert.equal(fixture.attempts(), 3);
});

test('Windows zero-response retries cannot renew exhausted connection re-arm budget', async () => {
  const fixture = connectionFactory([null, null, null]);
  let clock = 0;
  let transactions = 0;
  await assert.rejects(transactBoundedLocalAuthoritySocket({
    endpoint: '\\\\.\\pipe\\devbridge-test',
    timeoutMs: 1000,
    replaySafe: true,
    transact: async () => {
      transactions += 1;
      throw Object.assign(new Error('persistently stale pipe'), { code: 'EPIPE', localAuthorityResponseBytes: 0 });
    },
  }, {
    createConnection: fixture.createConnection,
    now: () => clock,
    wait: async () => { clock += 600; },
  }), (error) => error?.code === 'ETIMEDOUT');
  assert.equal(transactions, 2);
  assert.equal(fixture.attempts(), 2);
});

test('Windows zero-response replay remains cancellation-aware', async () => {
  const fixture = connectionFactory([null, null]);
  const controller = new AbortController();
  let transactions = 0;
  await assert.rejects(transactBoundedLocalAuthoritySocket({
    endpoint: '\\\\.\\pipe\\devbridge-test',
    timeoutMs: 1000,
    signal: controller.signal,
    replaySafe: true,
    transact: async () => {
      transactions += 1;
      throw Object.assign(new Error('stale pipe'), { code: 'EPIPE', localAuthorityResponseBytes: 0 });
    },
  }, {
    createConnection: fixture.createConnection,
    wait: async (_milliseconds, signal) => {
      controller.abort();
      if (signal.aborted) throw Object.assign(new Error('interrupted'), { code: 'ABORT_ERR' });
    },
  }), (error) => error?.code === 'ABORT_ERR');
  assert.equal(transactions, 1);
  assert.equal(fixture.attempts(), 1);
});

test('local authority transaction does not retry replay-unsafe operations or partial responses', async () => {
  for (const input of [
    { replaySafe: false, localAuthorityResponseBytes: 0 },
    { replaySafe: true, localAuthorityResponseBytes: 1 },
  ]) {
    const fixture = connectionFactory([null, null]);
    let transactions = 0;
    await assert.rejects(transactBoundedLocalAuthoritySocket({
      endpoint: '\\\\.\\pipe\\devbridge-test',
      timeoutMs: 1000,
      replaySafe: input.replaySafe,
      transact: async () => {
        transactions += 1;
        throw Object.assign(new Error('ambiguous pipe'), { code: 'EPIPE', localAuthorityResponseBytes: input.localAuthorityResponseBytes });
      },
    }, {
      createConnection: fixture.createConnection,
      wait: async () => {},
    }), (error) => error?.code === 'EPIPE');
    assert.equal(transactions, 1);
  }
});
