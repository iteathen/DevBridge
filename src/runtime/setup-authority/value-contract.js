export function createAuthorityValueContract({
  classes,
  requirements,
  approvals,
  availabilities,
  provenances,
  validations,
  maxProfiles,
} = {}) {
  const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
  const opaqueRefPattern = /^subject-[a-f0-9]{32}$/u;
  const classOrder = new Map(classes.map((value, index) => [value, index]));
  const maxEntries = maxProfiles * classes.length;

  function normalizeObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
    return value;
  }

  function rejectUnknown(value, allowed, name) {
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  }

  function normalizeIdentifier(value, name) {
    if (typeof value !== 'string' || !safeIdPattern.test(value)) throw new TypeError(`${name} is invalid`);
    return value;
  }

  function normalizeReference(value, name) {
    if (typeof value !== 'string' || !opaqueRefPattern.test(value)) throw new TypeError(`${name} must be an opaque local subject reference`);
    return value;
  }

  function normalizeChoice(value, values, name) {
    if (!values.includes(value)) throw new TypeError(`${name} is invalid`);
    return value;
  }

  function normalizeTimestamp(value, name) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${name} is invalid`);
    return value;
  }

  function normalizeRevision(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
    return value;
  }

  function normalizeProfiles(raw) {
    if (!Array.isArray(raw) || raw.length > maxProfiles) throw new TypeError('setup requestedProfiles is invalid');
    const values = raw.map((value, index) => normalizeIdentifier(value, `setup requestedProfiles[${index}]`));
    if (new Set(values).size !== values.length) throw new TypeError('setup requestedProfiles contains duplicates');
    return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
  }

  function normalizeClass(value, name) {
    return normalizeChoice(value, classes, name);
  }

  function normalizeRequirement(value, name) {
    return normalizeChoice(value, requirements, name);
  }

  function entryKey(profile, selectedClass) {
    return `${profile}\0${selectedClass}`;
  }

  function createDefaultEntry(profile, selectedClass, requirement = 'optional', provenance = 'default') {
    const normalizedRequirement = normalizeRequirement(requirement, 'setup authority requirement');
    return Object.freeze({
      profile: normalizeIdentifier(profile, 'setup authority profile'),
      class: normalizeClass(selectedClass, 'setup authority class'),
      requirement: normalizedRequirement,
      approval: normalizedRequirement === 'none' ? 'not-required' : 'unapproved',
      availability: 'unknown',
      subjectRef: null,
      provenance: normalizeChoice(provenance, provenances, 'setup authority provenance'),
    });
  }

  function normalizeEntry(raw, index, requestedProfiles) {
    const value = normalizeObject(raw, `setup authorities[${index}]`);
    rejectUnknown(value, new Set(['profile', 'class', 'requirement', 'approval', 'availability', 'subjectRef', 'provenance']), `setup authorities[${index}]`);
    const profile = normalizeIdentifier(value.profile, `setup authorities[${index}].profile`);
    if (!requestedProfiles.has(profile)) throw new TypeError('setup authority belongs to an unrequested profile');
    const selectedClass = normalizeClass(value.class, `setup authorities[${index}].class`);
    const requirement = normalizeRequirement(value.requirement, `setup authorities[${index}].requirement`);
    const approval = normalizeChoice(value.approval, approvals, `setup authorities[${index}].approval`);
    const availability = normalizeChoice(value.availability, availabilities, `setup authorities[${index}].availability`);
    const subjectRef = value.subjectRef == null ? null : normalizeReference(value.subjectRef, `setup authorities[${index}].subjectRef`);
    const provenance = normalizeChoice(value.provenance, provenances, `setup authorities[${index}].provenance`);

    if (requirement === 'none') {
      if (approval !== 'not-required' || availability !== 'unknown' || subjectRef !== null) {
        throw new TypeError('setup authority marked not required cannot carry approval, availability, or a subject');
      }
    } else {
      if (approval === 'not-required') throw new TypeError('setup authority approval contradicts its requirement');
      if (approval === 'approved' && subjectRef === null) throw new TypeError('approved setup authority requires an opaque subject reference');
      if (subjectRef === null && availability !== 'unknown') throw new TypeError('setup authority availability requires an opaque subject reference');
    }

    return Object.freeze({ profile, class: selectedClass, requirement, approval, availability, subjectRef, provenance });
  }

  function compareEntries(left, right) {
    const byProfile = left.profile.localeCompare(right.profile);
    if (byProfile !== 0) return byProfile;
    return classOrder.get(left.class) - classOrder.get(right.class);
  }

  function normalizeRequirements(raw, requestedProfiles) {
    if (!Array.isArray(raw) || raw.length > maxEntries) throw new TypeError('setup authority requirements is invalid');
    const profiles = new Set(requestedProfiles);
    const values = new Map();
    raw.forEach((entry, index) => {
      const value = normalizeObject(entry, `setup authority requirements[${index}]`);
      rejectUnknown(value, new Set(['profile', 'class', 'requirement']), `setup authority requirements[${index}]`);
      const profile = normalizeIdentifier(value.profile, `setup authority requirements[${index}].profile`);
      if (!profiles.has(profile)) throw new TypeError('setup authority requirement belongs to an unrequested profile');
      const selectedClass = normalizeClass(value.class, `setup authority requirements[${index}].class`);
      const requirement = normalizeRequirement(value.requirement, `setup authority requirements[${index}].requirement`);
      const key = entryKey(profile, selectedClass);
      if (values.has(key)) throw new TypeError('setup authority requirements contains a duplicate profile/class pair');
      values.set(key, requirement);
    });
    return values;
  }

  function normalizeValidation(value) {
    return normalizeChoice(value, validations, 'setup authority validation');
  }

  return Object.freeze({
    maxEntries,
    normalizeObject,
    rejectUnknown,
    normalizeIdentifier,
    normalizeTimestamp,
    normalizeRevision,
    normalizeProfiles,
    normalizeEntry,
    normalizeRequirements,
    normalizeValidation,
    entryKey,
    createDefaultEntry,
    compareEntries,
  });
}
