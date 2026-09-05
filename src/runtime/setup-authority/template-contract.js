export function createTemplateContract({
  protocol,
  classes,
  normalizeObject,
  rejectUnknown,
  normalizeProfiles,
  normalizeRequirements,
  entryKey,
  createSnapshot,
  normalizeSnapshot,
} = {}) {
  function normalizeTemplate(raw) {
    const value = normalizeObject(raw, 'setup authority template');
    rejectUnknown(value, new Set(['protocol', 'requestedProfiles', 'requirements']), 'setup authority template');
    if (value.protocol !== protocol) throw new TypeError('setup authority template protocol is unsupported');
    const requestedProfiles = normalizeProfiles(value.requestedProfiles);
    const requirements = normalizeRequirements(value.requirements, requestedProfiles);
    if (requirements.size !== requestedProfiles.length * classes.length) {
      throw new TypeError('setup authority template requirements must contain every authority class for every requested profile');
    }
    return Object.freeze({
      protocol,
      requestedProfiles,
      requirements: Object.freeze(requestedProfiles.flatMap((profile) => classes.map((selectedClass) => Object.freeze({
        profile,
        class: selectedClass,
        requirement: requirements.get(entryKey(profile, selectedClass)),
      })))),
    });
  }

  function exportTemplate(rawSnapshot) {
    const snapshot = normalizeSnapshot(rawSnapshot);
    return normalizeTemplate({
      protocol,
      requestedProfiles: snapshot.requestedProfiles,
      requirements: snapshot.authorities.map(({ profile, class: selectedClass, requirement }) => ({
        profile,
        class: selectedClass,
        requirement,
      })),
    });
  }

  function importTemplate(rawTemplate) {
    const template = normalizeTemplate(rawTemplate);
    const snapshot = createSnapshot({
      requestedProfiles: template.requestedProfiles,
      requirements: template.requirements,
    });
    return normalizeSnapshot({
      ...snapshot,
      authorities: snapshot.authorities.map((authority) => ({ ...authority, provenance: 'imported' })),
    });
  }

  return Object.freeze({ normalizeTemplate, exportTemplate, importTemplate });
}
