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

export function selectRepositoryDefaults(rawRepositories, {
  requested = null,
  autoSelectLimit = DEFAULT_AUTO_SELECT_LIMIT,
} = {}) {
  if (!Array.isArray(rawRepositories)) throw new TypeError('repository discovery result must be an array');
  if (!Number.isSafeInteger(autoSelectLimit) || autoSelectLimit < 0) throw new TypeError('repository auto-select limit is invalid');

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
