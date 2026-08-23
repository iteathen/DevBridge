const PROTOCOL = 'devbridge/setup-github-discovery-v1';
const PAGE_SIZE = 100;
const MAX_PAGES = 10_000;

function authenticatedIdentity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('GitHub authenticated identity response is invalid');
  if (!Number.isSafeInteger(raw.id) || raw.id < 1) throw new Error('GitHub authenticated identity id is invalid');
  if (typeof raw.login !== 'string' || raw.login.length === 0 || raw.login.includes('\0')) throw new Error('GitHub authenticated identity login is invalid');
  return Object.freeze({ id: raw.id, login: raw.login });
}

export async function discoverGitHubSetupScope(client) {
  if (!client || typeof client.request !== 'function') throw new TypeError('GitHub setup discovery client is invalid');
  const identityResponse = await client.request('GET', '/user', { critical: true, mutation: false });
  const identity = authenticatedIdentity(identityResponse.data);
  const repositories = [];
  const ids = new Set();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await client.request(
      'GET',
      `/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&direction=asc&per_page=${PAGE_SIZE}&page=${page}`,
      { critical: true, mutation: false },
    );
    if (!Array.isArray(response.data)) throw new Error('GitHub repository discovery response is invalid');
    for (const repository of response.data) {
      if (!repository || typeof repository !== 'object' || Array.isArray(repository)) throw new Error('GitHub repository discovery entry is invalid');
      if (!Number.isSafeInteger(repository.id) || repository.id < 1) throw new Error('GitHub repository discovery id is invalid');
      if (ids.has(repository.id)) throw new Error('GitHub repository discovery returned duplicate stable identities');
      ids.add(repository.id);
      repositories.push(repository);
    }
    if (response.data.length < PAGE_SIZE) {
      return Object.freeze({ protocol: PROTOCOL, identity, repositories: Object.freeze(repositories) });
    }
  }

  throw new Error('GitHub repository discovery exceeded the safety page bound without completing; discovery was not truncated');
}
