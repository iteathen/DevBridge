const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const STATE_KEY = 'github.repository-catalog.v1';
const STATE_PROTOCOL = 'devbridge/repository-catalog-v1';

function normalizeRepository(value, name) {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) throw new TypeError(`${name} must be owner/name`);
  return value;
}

function normalizePermissions(raw) {
  return Object.freeze({
    pull: raw?.pull === true,
    push: raw?.push === true,
    maintain: raw?.maintain === true,
    admin: raw?.admin === true,
  });
}

function discoveredRecord(raw, allowedOwners) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.archived === true || raw.disabled === true || raw.has_issues !== true) return null;
  const name = normalizeRepository(raw.full_name, 'discovered repository identity');
  const [owner] = name.split('/');
  if (!allowedOwners.has(owner.toLowerCase())) return null;
  const id = String(raw.id ?? '');
  if (!/^\d+$/u.test(id)) throw new TypeError('discovered repository immutable identity is invalid');
  return Object.freeze({
    name,
    id,
    source: 'authenticated-discovery',
    private: raw.private === true,
    permissions: normalizePermissions(raw.permissions),
  });
}

function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.protocol !== STATE_PROTOCOL || !Array.isArray(raw.repositories)) {
    throw new TypeError('stored repository discovery record is invalid');
  }
  return raw.repositories.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`stored repository[${index}] is invalid`);
    const name = normalizeRepository(entry.name, `stored repository[${index}].name`);
    const id = String(entry.id ?? '');
    if (!/^\d+$/u.test(id)) throw new TypeError(`stored repository[${index}].id is invalid`);
    return { name, id, source: 'authenticated-discovery', private: entry.private === true, permissions: normalizePermissions(entry.permissions) };
  });
}

function mergedRecords(configured, discovered) {
  const records = new Map();
  for (const name of configured) {
    records.set(name.toLowerCase(), { name, id: null, source: 'configured', private: null, permissions: null });
  }
  for (const entry of discovered) {
    const key = entry.name.toLowerCase();
    const existing = records.get(key);
    records.set(key, existing
      ? { ...entry, name: existing.name, source: 'configured+authenticated-discovery' }
      : { ...entry });
  }
  return [...records.values()].sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));
}

export class RepositoryCatalog {
  #client;
  #stateStore;
  #configured;
  #allowedOwners;
  #discovery;

  constructor({ client, stateStore, configuredRepositories, allowedOwners, discovery }) {
    if (!client || typeof client.request !== 'function' || !stateStore || typeof stateStore.get !== 'function' || typeof stateStore.set !== 'function') {
      throw new TypeError('repository catalog persistence/client boundary is incomplete');
    }
    if (!Array.isArray(configuredRepositories) || configuredRepositories.length === 0) throw new TypeError('repository catalog requires configured repositories');
    if (!Array.isArray(allowedOwners) || allowedOwners.length === 0) throw new TypeError('repository catalog requires allowed owners');
    this.#client = client;
    this.#stateStore = stateStore;
    this.#configured = configuredRepositories.map((value, index) => normalizeRepository(value, `configured repository[${index}]`));
    this.#allowedOwners = new Set(allowedOwners.map((value) => String(value).toLowerCase()));
    this.#discovery = discovery ?? { enabled: false, affiliations: [], maxRepositories: 30 };
  }

  async list() {
    if (this.#discovery.enabled !== true) {
      const records = mergedRecords(this.#configured, []);
      return {
        records,
        repositories: records.map((entry) => entry.name),
        discoveryEnabled: false,
        discoveredCount: 0,
        unchanged: true,
        truncated: false,
      };
    }

    const query = new URLSearchParams({
      visibility: 'all',
      affiliation: this.#discovery.affiliations.join(','),
      sort: 'full_name',
      direction: 'asc',
      per_page: String(this.#discovery.maxRepositories),
      page: '1',
    });
    const requestPath = `/user/repos?${query}`;
    const response = await this.#client.request('GET', requestPath, { conditional: true });
    let discovered;
    let truncated;
    if (response.notModified) {
      const stored = await this.#stateStore.get(STATE_KEY);
      if (!stored || typeof stored.truncated !== 'boolean') throw new TypeError('stored repository discovery truncation state is invalid');
      discovered = normalizeStored(stored);
      truncated = stored.truncated;
    } else {
      if (!Array.isArray(response.data)) throw new TypeError('authenticated repository discovery response must be an array');
      discovered = response.data.map((entry) => discoveredRecord(entry, this.#allowedOwners)).filter(Boolean);
      const link = response.headers?.get?.('link') ?? '';
      truncated = /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s|,|$)/iu.test(link);
      const identities = new Set();
      for (const entry of discovered) {
        const key = entry.name.toLowerCase();
        if (identities.has(key)) throw new TypeError('authenticated repository discovery returned a duplicate identity');
        identities.add(key);
      }
      await this.#stateStore.set(STATE_KEY, {
        protocol: STATE_PROTOCOL,
        truncated,
        repositories: discovered.map((entry) => ({
          name: entry.name,
          id: entry.id,
          private: entry.private,
          permissions: entry.permissions,
        })),
      });
    }
    const records = mergedRecords(this.#configured, discovered);
    return {
      records,
      repositories: records.map((entry) => entry.name),
      discoveryEnabled: true,
      discoveredCount: discovered.length,
      unchanged: response.notModified === true,
      truncated,
    };
  }
}
