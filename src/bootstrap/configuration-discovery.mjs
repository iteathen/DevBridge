import { createGitHubSession } from '../app/github-session.js';

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_REPOSITORIES = 100;
const MAX_AUTHORS = 100;

function linkHasNext(headers) {
  return /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s|,|$)/iu.test(headers?.get?.('link') ?? '');
}

function repositoryRecord(raw) {
  if (!raw || typeof raw !== 'object' || raw.archived === true || raw.disabled === true || raw.has_issues !== true) return null;
  if (typeof raw.full_name !== 'string' || !REPOSITORY.test(raw.full_name) || !/^\d+$/u.test(String(raw.id ?? ''))) return null;
  return Object.freeze({
    name: raw.full_name,
    id: String(raw.id),
    private: raw.private === true,
    permissions: Object.freeze({
      pull: raw.permissions?.pull === true,
      push: raw.permissions?.push === true,
      maintain: raw.permissions?.maintain === true,
      admin: raw.permissions?.admin === true,
    }),
  });
}

function authorRecord(raw, repository = null) {
  if (!raw || typeof raw !== 'object' || typeof raw.login !== 'string' || !/^\d+$/u.test(String(raw.id ?? ''))) return null;
  return { id: String(raw.id), login: raw.login, repositories: repository ? [repository] : [] };
}

function mergeAuthor(target, entry) {
  const current = target.get(entry.id);
  if (!current) {
    target.set(entry.id, entry);
    return;
  }
  for (const repository of entry.repositories) if (!current.repositories.includes(repository)) current.repositories.push(repository);
}

export async function createConfigurationDiscovery(config, {
  sessionFactory = createGitHubSession,
} = {}) {
  const session = await sessionFactory(config);
  const client = session.client;
  return Object.freeze({
    credential: Object.freeze({ provider: session.credential?.provider ?? null, source: session.credential?.source ?? null }),
    async listRepositories() {
      const query = new URLSearchParams({
        visibility: 'all',
        affiliation: 'owner,collaborator,organization_member',
        sort: 'full_name',
        direction: 'asc',
        per_page: String(MAX_REPOSITORIES),
        page: '1',
      });
      const response = await client.request('GET', `/user/repos?${query}`, { conditional: false });
      if (!Array.isArray(response.data)) throw new Error('Authenticated repository discovery response is not an array.');
      const records = response.data.map(repositoryRecord).filter(Boolean);
      const identities = new Set();
      for (const record of records) {
        const key = record.name.toLowerCase();
        if (identities.has(key)) throw new Error('Authenticated repository discovery returned duplicate repository identities.');
        identities.add(key);
      }
      return Object.freeze({ records, truncated: linkHasNext(response.headers) });
    },
    async listAuthors(repositories) {
      const selected = [...new Set(repositories.map((value) => String(value)))];
      if (selected.length < 1 || selected.length > 30 || selected.some((value) => !REPOSITORY.test(value))) {
        throw new TypeError('Author discovery requires 1-30 repository identities.');
      }
      const records = new Map();
      const warnings = [];
      let truncated = false;
      const user = await client.request('GET', '/user', { conditional: false });
      const self = authorRecord(user.data);
      if (self) mergeAuthor(records, self);
      for (const repository of selected) {
        const [owner, name] = repository.split('/');
        const query = new URLSearchParams({ affiliation: 'all', per_page: String(MAX_AUTHORS), page: '1' });
        try {
          const response = await client.request(
            'GET',
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators?${query}`,
            { conditional: false },
          );
          if (!Array.isArray(response.data)) throw new Error('Collaborator discovery response is not an array.');
          truncated ||= linkHasNext(response.headers);
          for (const raw of response.data) {
            const entry = authorRecord(raw, repository);
            if (entry) mergeAuthor(records, entry);
          }
        } catch (error) {
          warnings.push({ repository, reason: String(error?.message ?? error).slice(0, 500) });
        }
      }
      return Object.freeze({
        records: [...records.values()].sort((left, right) => left.login.localeCompare(right.login, 'en', { sensitivity: 'base' })),
        warnings,
        truncated,
      });
    },
  });
}
