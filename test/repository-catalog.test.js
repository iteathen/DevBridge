import test from 'node:test';
import assert from 'node:assert/strict';
import { RepositoryCatalog } from '../src/github/repository-catalog.js';

function memoryStore(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(key) { return structuredClone(data[key]); },
    async set(key, value) { data[key] = structuredClone(value); },
    snapshot() { return structuredClone(data); },
  };
}

function repository(overrides = {}) {
  return {
    id: 1297121161,
    full_name: 'iteathen/UCI_Arena',
    archived: false,
    disabled: false,
    has_issues: true,
    private: true,
    permissions: { pull: true, push: true, maintain: true, admin: true },
    ...overrides,
  };
}

function discovery(overrides = {}) {
  return {
    enabled: true,
    affiliations: ['owner', 'collaborator', 'organization_member'],
    maxRepositories: 30,
    ...overrides,
  };
}

test('configured repositories require no authenticated discovery request', async () => {
  let requests = 0;
  const catalog = new RepositoryCatalog({
    client: { async request() { requests += 1; } },
    stateStore: memoryStore(),
    configuredRepositories: ['iteathen/DevBridge', 'iteathen/UCI_Arena'],
    allowedOwners: ['iteathen'],
    discovery: { enabled: false, affiliations: [], maxRepositories: 30 },
  });

  const selection = await catalog.list();
  assert.equal(requests, 0);
  assert.deepEqual(selection.repositories, ['iteathen/DevBridge', 'iteathen/UCI_Arena']);
  assert.equal(selection.discoveryEnabled, false);
  assert.equal(selection.truncated, false);
});

test('authenticated discovery is owner-filtered, bounded, durable, and merged with configured queues', async () => {
  let request;
  const store = memoryStore();
  const catalog = new RepositoryCatalog({
    client: {
      async request(method, requestPath, options) {
        request = { method, requestPath, options };
        return {
          notModified: false,
          headers: { get: (name) => name === 'link' ? '<https://api.github.com/user/repos?page=2>; rel="next"' : null },
          data: [
            repository(),
            repository({ id: 1337742670, full_name: 'iteathen/DevBridge', private: false }),
            repository({ id: 7, full_name: 'foreign/visible', private: false }),
            repository({ id: 8, full_name: 'iteathen/archived', archived: true }),
            repository({ id: 9, full_name: 'iteathen/no-issues', has_issues: false }),
          ],
        };
      },
    },
    stateStore: store,
    configuredRepositories: ['iteathen/DevBridge'],
    allowedOwners: ['iteathen'],
    discovery: discovery({ maxRepositories: 2 }),
  });

  const selection = await catalog.list();
  assert.equal(request.method, 'GET');
  assert.equal(request.options.conditional, true);
  const url = new URL(request.requestPath, 'https://api.github.test');
  assert.equal(url.pathname, '/user/repos');
  assert.equal(url.searchParams.get('per_page'), '2');
  assert.equal(url.searchParams.get('affiliation'), 'owner,collaborator,organization_member');
  assert.deepEqual(selection.repositories, ['iteathen/DevBridge', 'iteathen/UCI_Arena']);
  assert.equal(selection.records[0].id, '1337742670');
  assert.equal(selection.records[0].source, 'configured+authenticated-discovery');
  assert.equal(selection.records[1].id, '1297121161');
  assert.equal(selection.discoveredCount, 2);
  assert.equal(selection.truncated, true);

  const persisted = store.snapshot()['github.repository-catalog.v1'];
  assert.equal(persisted.protocol, 'devbridge/repository-catalog-v1');
  assert.equal(persisted.truncated, true);
  assert.deepEqual(persisted.repositories.map((entry) => entry.name), ['iteathen/UCI_Arena', 'iteathen/DevBridge']);
});

test('conditional discovery reuses validated durable identities and permissions', async () => {
  const store = memoryStore({
    'github.repository-catalog.v1': {
      protocol: 'devbridge/repository-catalog-v1',
      truncated: false,
      repositories: [{
        name: 'iteathen/UCI_Arena',
        id: '1297121161',
        private: true,
        permissions: { pull: true, push: 'not-authority', admin: false },
      }],
    },
  });
  const catalog = new RepositoryCatalog({
    client: { async request() { return { notModified: true, data: null, headers: new Headers() }; } },
    stateStore: store,
    configuredRepositories: ['iteathen/DevBridge'],
    allowedOwners: ['iteathen'],
    discovery: discovery(),
  });

  const selection = await catalog.list();
  assert.equal(selection.unchanged, true);
  assert.equal(selection.records[1].permissions.pull, true);
  assert.equal(selection.records[1].permissions.push, false);
  assert.equal(selection.records[1].permissions.admin, false);
});

test('malformed immutable identities and duplicate discovered names fail closed', async () => {
  const options = {
    stateStore: memoryStore(),
    configuredRepositories: ['iteathen/DevBridge'],
    allowedOwners: ['iteathen'],
    discovery: discovery(),
  };
  const malformed = new RepositoryCatalog({
    ...options,
    client: { async request() { return { notModified: false, data: [repository({ id: 'mutable' })], headers: new Headers() }; } },
  });
  await assert.rejects(() => malformed.list(), /immutable identity is invalid/u);

  const duplicate = new RepositoryCatalog({
    ...options,
    client: {
      async request() {
        return {
          notModified: false,
          data: [repository(), repository({ id: 2, full_name: 'ITEATHEN/uci_arena' })],
          headers: new Headers(),
        };
      },
    },
  });
  await assert.rejects(() => duplicate.list(), /duplicate identity/u);
});
