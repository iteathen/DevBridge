const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const SAFE_CHOICE = /^[a-z][a-z0-9-]{0,63}$/u;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function profileList(raw, name) {
  if (!Array.isArray(raw) || raw.length > 1_024) throw new TypeError(`${name} is invalid`);
  const values = raw.map((value, index) => {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name}[${index}] is invalid`);
    return value;
  });
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicates`);
  return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
}

function choiceMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('setup profile choices are invalid');
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > 64) throw new TypeError('setup profile choices are invalid');
  const values = new Map();
  for (const [name, profiles] of entries) {
    if (!SAFE_CHOICE.test(name)) throw new TypeError('setup profile choice name is invalid');
    values.set(name, profileList(profiles, `setup profile choice ${name}`));
  }
  return values;
}

export function resolveSetupProfileSelection(input = {}, policy = {}) {
  const selectedInput = exactObject(input, new Set(['choice', 'acceptedProfiles', 'workingProfiles']), 'setup profile selection input');
  const selectedPolicy = exactObject(policy, new Set(['defaultProfiles', 'choices', 'deferChoice']), 'setup profile selection policy');
  const {
    choice = null,
    acceptedProfiles = null,
    workingProfiles = null,
  } = selectedInput;
  const {
    defaultProfiles,
    choices,
    deferChoice = 'defer',
  } = selectedPolicy;
  const defaults = profileList(defaultProfiles, 'setup default profiles');
  const accepted = acceptedProfiles == null ? null : profileList(acceptedProfiles, 'setup accepted profiles');
  const working = workingProfiles == null ? null : profileList(workingProfiles, 'setup working profiles');
  const available = choiceMap(choices);
  if (typeof deferChoice !== 'string' || !SAFE_CHOICE.test(deferChoice) || available.has(deferChoice)) {
    throw new TypeError('setup deferred profile choice is invalid');
  }
  if (choice != null && (typeof choice !== 'string' || !SAFE_CHOICE.test(choice))) throw new TypeError('setup profile choice is invalid');

  if (choice === deferChoice) {
    return Object.freeze({
      state: 'deferred',
      profiles: accepted ?? Object.freeze([]),
      pendingProfiles: working,
      source: 'explicit',
    });
  }
  if (choice != null) {
    const selected = available.get(choice);
    if (!selected) throw new TypeError('setup profile choice is unsupported');
    return Object.freeze({ state: 'selected', profiles: selected, pendingProfiles: null, source: 'explicit' });
  }
  if (working != null) return Object.freeze({ state: 'selected', profiles: working, pendingProfiles: null, source: 'working' });
  if (accepted != null) return Object.freeze({ state: 'selected', profiles: accepted, pendingProfiles: null, source: 'accepted' });
  return Object.freeze({ state: 'selected', profiles: defaults, pendingProfiles: null, source: 'default' });
}
