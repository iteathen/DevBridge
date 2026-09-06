import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueStatusReporter } from '../src/github/issue-status-reporter.js';
import { RateLimitError } from '../src/errors.js';
import { captureFailureDiagnostics } from '../src/run/failure-diagnostics.js';

function store() {
  const records = new Map();
  return {
    records,
    async get(key) { return structuredClone(records.get(key)); },
    async set(key, value) { records.set(key, structuredClone(value)); },
    async entries(prefix = '') { return [...records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]); },
  };
}

function request(overrides = {}) {
  return { issueNumber: 7, runId: 'pp-7-test', revision: 'a'.repeat(64), stage: 'FAILED', summary: 'APT exited 100: matching dependency is unavailable.', capsule: { protocol: 'devbridge/context-v1' }, terminal: true, ...overrides };
}

function fixture(stateStore = store()) {
  const comments = [];
  const calls = [];
  let losePost = false;
  let unavailable = false;
  const client = { async request(method, path, options = {}) {
    calls.push({ method, path, options });
    if (unavailable) throw new Error('connection unavailable');
    if (path === '/graphql') return { data: { data: { viewer: { databaseId: 12 } } } };
    if (method === 'GET') return { data: structuredClone(comments), headers: new Headers() };
    if (method === 'POST') {
      const comment = { id: 101 + comments.length, user: { id: 12 }, body: options.body.body, issue_url: 'https://api.github.com/repos/owner/queue/issues/7' };
      comments.push(comment);
      if (losePost) { losePost = false; throw new Error('accepted POST response lost'); }
      return { data: structuredClone(comment) };
    }
    const comment = comments.find(entry => path.endsWith(`/${entry.id}`));
    assert.ok(comment, 'PATCH uses the confirmed owned comment');
    comment.body = options.body.body;
    return { data: structuredClone(comment) };
  } };
  const create = (options = {}) => new IssueStatusReporter({ client, stateStore, queueRepository: 'owner/queue', secretValues: ['fixture-secret-value'], ...options });
  return { stateStore, comments, calls, client, create, loseNextPost() { losePost = true; }, outage(value) { unavailable = value; } };
}

test('ambiguous initial POST is reconciled after reporter restart without duplicate creation', async () => {
  const f = fixture();
  f.loseNextPost();
  await assert.rejects(f.create().publish(request()), /response lost/);
  assert.equal(f.comments.length, 1);
  assert.equal((await f.create().pending()).length, 1);
  const result = await f.create().reconcile(request());
  assert.equal(result.published, true);
  assert.equal(result.commentId, 101);
  assert.equal(f.calls.filter(entry => entry.method === 'POST' && entry.options.mutation !== false).length, 1);
  assert.deepEqual(await f.create().pending(), []);
});

test('terminal intent survives outage and supersedes an ambiguous progress creation', async () => {
  const f = fixture();
  f.loseNextPost();
  await assert.rejects(f.create().publish(request({ stage: 'RUNNING', summary: 'working', terminal: false })), /response lost/);
  f.outage(true);
  await assert.rejects(f.create().publish(request({ summary: 'failure fixture-secret-value' })), /unavailable/);
  assert.doesNotMatch(JSON.stringify([...f.stateStore.records]), /fixture-secret-value/);
  f.outage(false);
  await f.create().reconcile(request());
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /failure \[REDACTED\]/);
  assert.match(f.comments[0].body, /FAILED/);
  assert.deepEqual(await f.create().pending(), []);
});

test('outage before any request retains the redacted projection without repeating work', async () => {
  const f = fixture();
  f.outage(true);
  await assert.rejects(f.create().publish(request()), /unavailable/);
  assert.equal((await f.create().pending())[0].runId, 'pp-7-test');
  f.outage(false);
  await f.create().reconcile(request());
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /matching dependency is unavailable/);
});

test('a copied marker from another actor cannot become an owned comment', async () => {
  const f = fixture();
  f.loseNextPost();
  await assert.rejects(f.create().publish(request()));
  f.comments[0].user.id = 99;
  const result = await f.create().reconcile(request());
  assert.equal(result.published, false);
  assert.equal(f.calls.filter(entry => entry.method === 'PATCH').length, 0);
  assert.equal((await f.create().pending()).length, 1);
});

test('status recovery rejects a different task revision and coalesces concurrent progress', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 8 }, () => f.create().publish(request({ stage: 'RUNNING', terminal: false }))));
  assert.equal(f.comments.length, 1);
  await assert.rejects(f.create().reconcile(request({ revision: 'b'.repeat(64) })), /subject/);
});

test('ambiguous creation scans subsequent pages and refuses incomplete observation before POST retry', async () => {
  const f = fixture();
  f.loseNextPost();
  await assert.rejects(f.create().publish(request()));
  const original = f.client.request;
  f.client.request = async (method, url, options) => {
    if (method === 'GET' && url.endsWith('page=1')) return { data: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: 'unrelated' })), headers: new Headers({ link: '<https://untrusted.example/?page=2>; rel="next"' }) };
    return original(method, url, options);
  };
  assert.equal((await f.create().reconcile(request())).published, true);
  assert.equal(f.comments.length, 1);
  assert.ok(f.calls.every(entry => !entry.path.includes('untrusted.example')));

  const g = fixture();
  g.loseNextPost();
  await assert.rejects(g.create().publish(request()));
  let pages = 0;
  g.client.request = async () => { pages += 1; return { data: Array.from({ length: 100 }, () => ({ body: 'unrelated' })), headers: new Headers() }; };
  const incomplete = await g.create({ now: () => Date.now() + 1_000_000 }).reconcile(request());
  assert.equal(incomplete.reason, 'observation-budget-exhausted');
  assert.equal(pages, 10);
  assert.equal((await g.create().pending()).length, 1);
});

test('duplicate, modified, cross-issue and malformed correlation never authorize PATCH', async () => {
  for (const mutate of [
    comments => comments.push({ ...comments[0], id: 102 }),
    comments => { comments[0].body += '\nchanged'; },
    comments => { comments[0].issue_url = 'https://api.github.com/repos/owner/queue/issues/8'; },
  ]) {
    const f = fixture();
    f.loseNextPost();
    await assert.rejects(f.create().publish(request()));
    mutate(f.comments);
    assert.equal((await f.create().reconcile(request())).published, false);
    assert.equal(f.calls.filter(entry => entry.method === 'PATCH').length, 0);
  }
});

test('server pacing survives restart and a newer pending terminal report', async () => {
  const f = fixture();
  const original = f.client.request;
  let now = 1000;
  f.client.request = async () => { throw new RateLimitError('retry later', { retryAt: 9000 }); };
  await assert.rejects(f.create({ now: () => now }).publish(request({ stage: 'RUNNING', terminal: false })));
  f.client.request = original;
  assert.equal((await f.create({ now: () => now }).publish(request())).reason, 'server-pacing');
  assert.equal(f.calls.length, 0);
  now = 9000;
  assert.equal((await f.create({ now: () => now }).reconcile(request())).published, true);
  assert.equal(f.comments.length, 1);
});

test('ambiguous PATCH retries its known ID and cannot downgrade terminal failure to progress', async () => {
  const f = fixture();
  await f.create().publish(request({ stage: 'RUNNING', terminal: false }));
  const original = f.client.request;
  let losePatch = true;
  f.client.request = async (method, url, options) => {
    const result = await original(method, url, options);
    if (method === 'PATCH' && losePatch) { losePatch = false; throw new Error('PATCH response lost'); }
    return result;
  };
  await assert.rejects(f.create().publish(request()), /response lost/);
  await f.create().publish(request({ stage: 'RUNNING', terminal: false, force: true }));
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /FAILED/);
  assert.deepEqual(await f.create().pending(), []);
});

test('diagnostic output flood preserves bounded terminal classification and redacts every projection field', async () => {
  const f = fixture();
  await f.create().publish(request({ summary: 'failed at C:\\private\\source.txt', capsule: { protocol: 'devbridge/context-v1', outputTail: 'fixture-secret-value /private/key.txt' },
    diagnostics: captureFailureDiagnostics({ stage: 'compile', result: { exitCode: 100, stderr: '\n'.repeat(50_000), outputTruncated: true } }),
  }));
  assert.ok(Buffer.byteLength(f.comments[0].body) <= 48_000);
  assert.match(f.comments[0].body, /Exit status: 100/);
  assert.match(f.comments[0].body, /truncated/);
  assert.doesNotMatch(f.comments[0].body, /private|fixture-secret-value/);
});

test('minimum comment budget keeps terminal evidence when the input context cannot fit', async () => {
  const f = fixture();
  await f.create({ maxCommentBytes: 4096 }).publish(request({ capsule: { protocol: 'devbridge/context-v1', handoff: 'x'.repeat(200_000) },
    diagnostics: captureFailureDiagnostics({ stage: 'test', result: { exitCode: 7, stderr: 'Failure text\n'.repeat(1000) } }),
  }));
  assert.ok(Buffer.byteLength(f.comments[0].body) <= 4096);
  assert.match(f.comments[0].body, /Exit status: 7/);
  assert.match(f.comments[0].body, /Context exceeded/);
});

test('creation intent persistence failure prevents every remote effect', async () => {
  const f = fixture();
  f.stateStore.set = async () => { throw new Error('state disk unavailable'); };
  await assert.rejects(f.create().publish(request()), /disk unavailable/);
  assert.equal(f.calls.length, 0);
});

test('unobserved creation has three paced attempts and never retries under another publisher', async () => {
  const f = fixture();
  let now = 1000;
  let actorId = 12;
  let creates = 0;
  f.client.request = async (method, url) => {
    if (url === '/graphql') return { data: { data: { viewer: { databaseId: actorId } } } };
    if (method === 'GET') return { data: [] };
    creates += 1;
    throw new Error('POST failed before receipt');
  };
  const reporter = () => f.create({ now: () => now, progressIntervalMs: 100 });
  await assert.rejects(reporter().publish(request()));
  assert.equal((await reporter().reconcile(request())).reason, 'creation-observation-pending');
  now += 100;
  actorId = 99;
  assert.equal((await reporter().reconcile(request())).reason, 'publisher-identity-changed');
  assert.equal(creates, 1);
  actorId = 12;
  await assert.rejects(reporter().reconcile(request()));
  now += 100;
  await assert.rejects(reporter().reconcile(request()));
  now += 100;
  assert.equal((await reporter().reconcile(request())).reason, 'creation-attempts-exhausted');
  assert.equal(creates, 3);
  assert.equal((await reporter().pending()).length, 1);
});
