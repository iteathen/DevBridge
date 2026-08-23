const PROTOCOL = 'devbridge/setup-repository-selection-v1';
const DEFAULT_AUTO_SELECT_LIMIT = 30;

function repositoryName(value) {
  if (typeof value !== 'string' || !/^[^/\s]+\/[^/\s]+$/u.test(value)) throw new TypeError('repository full_name is invalid');
  return value;
}

function normalizedRepository(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('repository discovery entry is invalid');
  if (!Number.isSafeInteger(raw.id) || raw.id < 1) throw new TypeError('repository id is invalid');
  const fullName = repositoryName(raw.full_name);
  const permissions = raw.permissions && typeof raw.permissions === 'object' && !Array.isArray(raw.permissions)
    ? raw.permissions
    : {};
  return Object.freeze({
    id: raw.id,
    fullName,
    archived: raw.archived === true,
    disabled: raw.disabled === true,
    writable: permissions.push === true,
    private: raw.private === true,
  });
}

function classify(repository) {
  if (repository.archived) return 'archived';
  if (repository.disabled) return 'disabled';
  if (!repository.writable) return 'read-only';
  return null;
}

function normalizeRequested(requested) {
  if (requested == null) return Object.freeze([]);
  if (!Array.isArray(requested)) throw new TypeError('requested repositories must be an array');
  const values = requested.map((entry) => {
    if (entry === 'all') return 'all';
    return repositoryName(entry);
  });
  if (values.includes('all') && values.length !== 1) throw new TypeError('repository selection "all" cannot be combined with named repositories');
  return Object.freeze([...new Set(values)]);
}

function normalizeAccepted(accepted) {
  if (!Array.isArray(accepted)) throw new TypeError('accepted repositories must be an array');
  const ids = new Set();
  return Object.freeze(accepted.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('accepted repository entry is invalid');
    if (!Number.isSafeInteger(entry.id) || entry.id < 1) throw new TypeError('accepted repository id is invalid');
    if (ids.has(entry.id)) throw new Error('accepted repositories contain a duplicate stable identity');
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, fullName: repositoryName(entry.fullName) });
  }));
}

export function selectRepositoryDefaults(rawRepositories, {
  requested = null,
  accepted = null,
  autoSelectLimit = DEFAULT_AUTO_SELECT_LIMIT,
} = {}) {
  if (!Array.isArray(rawRepositories)) throw new TypeError('repository discovery result must be an array');
  if (!Number.isSafeInteger(autoSelectLimit) || autoSelectLimit < 0) throw new TypeError('repository auto-select limit is invalid');
  if (requested != null && accepted != null) throw new TypeError('requested and accepted repository selections are mutually exclusive');

  const repositories = rawRepositories.map(normalizedRepository);
  const byId = new Set();
  const byName = new Set();
  for (const repository of repositories) {
    if (byId.has(repository.id) || byName.has(repository.fullName)) throw new Error('repository discovery returned a duplicate stable identity');
    byId.add(repository.id);
    byName.add(repository.fullName);
  }

  const eligible = [];
  const excluded = [];
  for (const repository of repositories) {
    const reason = classify(repository);
    if (reason) excluded.push(Object.freeze({ id: repository.id, fullName: repository.fullName, reason }));
    else eligible.push(repository);
  }
  eligible.sort((left, right) => left.fullName.localeCompare(right.fullName));
  excluded.sort((left, right) => left.fullName.localeCompare(right.fullName));

  const explicit = normalizeRequested(requested);
  const preserved = accepted == null ? null : normalizeAccepted(accepted);
  let selected = [];
  let needsSelection = false;
  let reason = null;
  if (explicit.length === 1 && explicit[0] === 'all') {
    selected = eligible;
  } else if (explicit.length > 0) {
    const eligibleByName = new Map(eligible.map((repository) => [repository.fullName, repository]));
    const missing = explicit.filter((name) => !eligibleByName.has(name));
    if (missing.length > 0) throw new Error(`requested repositories are not eligible: ${missing.join(', ')}`);
    selected = explicit.map((name) => eligibleByName.get(name));
  } else if (preserved != null) {
    const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
    const missing = preserved.filter((entry) => !repositoriesById.has(entry.id));
    if (missing.length > 0) throw new Error(`accepted repositories are unavailable: ${missing.map((entry) => entry.fullName).join(', ')}`);
    const unavailable = preserved
      .map((entry) => repositoriesById.get(entry.id))
      .filter((repository) => classify(repository) != null);
    if (unavailable.length > 0) throw new Error(`accepted repositories are not eligible: ${unavailable.map((repository) => repository.fullName).join(', ')}`);
    selected = preserved.map((entry) => repositoriesById.get(entry.id));
  } else if (eligible.length <= autoSelectLimit) {
    selected = eligible;
  } else {
    needsSelection = true;
    reason = `${eligible.length} eligible repositories require an explicit selection; use --repository owner/name or --repository all`;
  }

  return Object.freeze({
    protocol: PROTOCOL,
    discoveredCount: repositories.length,
    eligibleCount: eligible.length,
    selectedCount: selected.length,
    needsSelection,
    reason,
    selected: Object.freeze(selected.map((repository) => Object.freeze({ id: repository.id, fullName: repository.fullName, private: repository.private }))),
    excluded: Object.freeze(excluded),
  });
}

export { DEFAULT_AUTO_SELECT_LIMIT as SETUP_REPOSITORY_AUTO_SELECT_LIMIT };
