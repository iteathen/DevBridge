export function createSnapshotContract({
  protocol,
  classes,
  maxEntries,
  normalizeObject,
  rejectUnknown,
  normalizeProfiles,
  normalizeEntry,
  normalizeRequirements,
  entryKey,
  createDefaultEntry,
  compareEntries,
} = {}) {
  function normalizeSnapshot(raw) {
    const value = normalizeObject(raw, 'setup authority snapshot');
    rejectUnknown(value, new Set(['protocol', 'requestedProfiles', 'authorities']), 'setup authority snapshot');
    if (value.protocol !== protocol) throw new TypeError('setup authority snapshot protocol is unsupported');
    const requestedProfiles = normalizeProfiles(value.requestedProfiles);
    if (!Array.isArray(value.authorities) || value.authorities.length > maxEntries) throw new TypeError('setup authorities is invalid');
    if (value.authorities.length !== requestedProfiles.length * classes.length) {
      throw new TypeError('setup authorities must contain every authority class for every requested profile');
    }
    const requestedSet = new Set(requestedProfiles);
    const seen = new Set();
    const authorities = value.authorities.map((entry, index) => {
      const normalized = normalizeEntry(entry, index, requestedSet);
      const key = entryKey(normalized.profile, normalized.class);
      if (seen.has(key)) throw new TypeError('setup authorities contains a duplicate profile/class pair');
      seen.add(key);
      return normalized;
    });
    for (const profile of requestedProfiles) {
      for (const selectedClass of classes) {
        if (!seen.has(entryKey(profile, selectedClass))) throw new TypeError('setup authorities is incomplete');
      }
    }
    return Object.freeze({
      protocol,
      requestedProfiles,
      authorities: Object.freeze(authorities.sort(compareEntries)),
    });
  }

  function createSnapshot({ requestedProfiles = [], requirements = [] } = {}) {
    const profiles = normalizeProfiles(requestedProfiles);
    const overrides = normalizeRequirements(requirements, profiles);
    return normalizeSnapshot({
      protocol,
      requestedProfiles: profiles,
      authorities: profiles.flatMap((profile) => classes.map((selectedClass) => (
        createDefaultEntry(profile, selectedClass, overrides.get(entryKey(profile, selectedClass)) ?? 'optional')
      ))),
    });
  }

  function replaceProfiles(rawSnapshot, { requestedProfiles, requirements = [] } = {}) {
    const current = normalizeSnapshot(rawSnapshot);
    const profiles = normalizeProfiles(requestedProfiles);
    const overrides = normalizeRequirements(requirements, profiles);
    const existing = new Map(current.authorities.map((entry) => [entryKey(entry.profile, entry.class), entry]));
    const authorities = [];
    for (const profile of profiles) {
      for (const selectedClass of classes) {
        const key = entryKey(profile, selectedClass);
        const prior = existing.get(key) ?? null;
        const requirement = overrides.get(key) ?? prior?.requirement ?? 'optional';
        authorities.push(prior && prior.requirement === requirement
          ? prior
          : createDefaultEntry(profile, selectedClass, requirement));
      }
    }
    return normalizeSnapshot({ protocol, requestedProfiles: profiles, authorities });
  }

  function replaceEntry(rawSnapshot, rawEntry) {
    const current = normalizeSnapshot(rawSnapshot);
    const requestedSet = new Set(current.requestedProfiles);
    const replacement = normalizeEntry(rawEntry, 0, requestedSet);
    const target = entryKey(replacement.profile, replacement.class);
    let changed = false;
    const authorities = current.authorities.map((entry) => {
      if (entryKey(entry.profile, entry.class) !== target) return entry;
      changed = true;
      return replacement;
    });
    if (!changed) throw new TypeError('setup authority replacement target does not exist');
    return normalizeSnapshot({ ...current, authorities });
  }

  return Object.freeze({ normalizeSnapshot, createSnapshot, replaceProfiles, replaceEntry });
}
