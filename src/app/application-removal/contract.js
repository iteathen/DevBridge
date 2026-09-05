export const APPLICATION_REMOVAL_PROTOCOL = 'devbridge/application-removal-v1';

export const REMOVAL_MODES = Object.freeze(['application', 'purge']);

const MODE_SET = new Set(REMOVAL_MODES);
const SCOPES = new Set(['payload', 'authority', 'managed']);
const PROVENANCE = new Set(['created', 'adopted', 'foreign']);
const PHASES = new Set([
  'planned',
  'attempted',
  'observed',
  'reconciled',
  'retirement-planned',
  'retirement-attempted',
  'retirement-observed',
  'completed',
]);
const OUTCOMES = new Set(['absent', 'removed']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ITEMS = 4096;
const MAX_EFFECTS = 8192;
const MAX_IDENTITIES = 4096;
const MAX_ATTEMPTS = 2;

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

export function safeIdentity(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

export function removalMode(value, name = 'removal mode') {
  if (typeof value !== 'string' || !MODE_SET.has(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function uniqueIdentities(raw, name, maximum = MAX_IDENTITIES) {
  if (!Array.isArray(raw) || raw.length > maximum) throw new TypeError(`${name} is invalid`);
  const values = raw.map((value, index) => safeIdentity(value, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} contains duplicate identities`);
  return Object.freeze(values.sort((left, right) => left.localeCompare(right)));
}

function normalizeEffect(raw, index, seen) {
  const value = exactObject(raw, new Set(['identity', 'bytes', 'terminal']), `removal effect ${index}`);
  const identity = safeIdentity(value.identity, `removal effect ${index}.identity`);
  if (seen.has(identity)) throw new TypeError('removal effects contain duplicate identities');
  seen.add(identity);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new TypeError(`removal effect ${index}.bytes is invalid`);
  return Object.freeze({
    identity,
    bytes: value.bytes,
    terminal: boolean(value.terminal, `removal effect ${index}.terminal`),
  });
}

function normalizeItem(raw, index, effectIdentities) {
  const value = exactObject(
    raw,
    new Set(['identity', 'scope', 'provenance', 'protections', 'references', 'after', 'effects']),
    `removal item ${index}`,
  );
  const identity = safeIdentity(value.identity, `removal item ${index}.identity`);
  if (!SCOPES.has(value.scope)) throw new TypeError(`removal item ${index}.scope is invalid`);
  if (!PROVENANCE.has(value.provenance)) throw new TypeError(`removal item ${index}.provenance is invalid`);
  if (!Array.isArray(value.effects) || value.effects.length > MAX_EFFECTS) throw new TypeError(`removal item ${index}.effects is invalid`);
  const effects = Object.freeze(value.effects.map((entry, effectIndex) => normalizeEffect(entry, effectIndex, effectIdentities)));
  if (value.provenance === 'foreign' && effects.length !== 0) throw new TypeError('foreign removal item cannot carry effects');
  if (value.provenance !== 'foreign') {
    if (effects.length === 0 || effects.slice(0, -1).some((entry) => entry.terminal) || effects.at(-1).terminal !== true) {
      throw new TypeError(`removal item ${index} must end with one terminal effect`);
    }
  }
  const after = uniqueIdentities(value.after, `removal item ${index}.after`);
  if (after.includes(identity)) throw new TypeError('removal item cannot depend on itself');
  return Object.freeze({
    identity,
    scope: value.scope,
    provenance: value.provenance,
    protections: uniqueIdentities(value.protections, `removal item ${index}.protections`),
    references: uniqueIdentities(value.references, `removal item ${index}.references`),
    after,
    effects,
  });
}

function validateDependencyGraph(items) {
  const byIdentity = new Map(items.map((item) => [item.identity, item]));
  const visiting = new Set();
  const complete = new Set();
  function visit(identity) {
    if (complete.has(identity)) return;
    if (visiting.has(identity)) throw new TypeError('removal item dependency graph contains a cycle');
    visiting.add(identity);
    for (const dependency of byIdentity.get(identity).after) visit(dependency);
    visiting.delete(identity);
    complete.add(identity);
  }
  for (const identity of [...byIdentity.keys()].sort((left, right) => left.localeCompare(right))) visit(identity);
}

export function normalizeRemovalSnapshot(raw) {
  const value = exactObject(
    raw,
    new Set(['protocol', 'generation', 'coverage', 'mutationActive', 'protectedReferences', 'items']),
    'removal snapshot',
  );
  if (value.protocol !== APPLICATION_REMOVAL_PROTOCOL) throw new TypeError('removal snapshot protocol is unsupported');
  if (!Array.isArray(value.coverage) || value.coverage.length > REMOVAL_MODES.length) throw new TypeError('removal snapshot coverage is invalid');
  const coverage = value.coverage.map((entry, index) => removalMode(entry, `removal snapshot.coverage[${index}]`));
  if (new Set(coverage).size !== coverage.length) throw new TypeError('removal snapshot coverage contains duplicates');
  if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) throw new TypeError('removal snapshot items are invalid');
  let effectCount = 0;
  for (const entry of value.items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.effects)) {
      throw new TypeError('removal snapshot item effects are invalid');
    }
    effectCount += entry.effects.length;
    if (effectCount > MAX_EFFECTS) throw new TypeError('removal snapshot exceeds its effect bound');
  }
  const effectIdentities = new Set();
  const items = value.items.map((entry, index) => normalizeItem(entry, index, effectIdentities));
  const itemIdentities = new Set(items.map((entry) => entry.identity));
  if (itemIdentities.size !== items.length) throw new TypeError('removal snapshot contains duplicate item identities');
  for (const item of items) {
    if (item.after.some((identity) => !itemIdentities.has(identity))) throw new TypeError('removal item dependency is unavailable');
  }
  validateDependencyGraph(items);
  return Object.freeze({
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    generation: safeIdentity(value.generation, 'removal snapshot.generation'),
    coverage: Object.freeze(REMOVAL_MODES.filter((mode) => coverage.includes(mode))),
    mutationActive: boolean(value.mutationActive, 'removal snapshot.mutationActive'),
    protectedReferences: uniqueIdentities(value.protectedReferences, 'removal snapshot.protectedReferences'),
    items: Object.freeze(items.sort((left, right) => left.identity.localeCompare(right.identity))),
  });
}

export function normalizeInspectionRequest(raw) {
  const value = exactObject(raw, new Set(['mode']), 'removal inspection request');
  return Object.freeze({ mode: removalMode(value.mode) });
}

export function normalizeRemovalRequest(raw) {
  const value = exactObject(raw, new Set(['mode', 'planDigest', 'confirmation']), 'removal request');
  if (value.confirmation !== 'REMOVE') throw new TypeError('removal confirmation must be exact literal REMOVE');
  return Object.freeze({
    mode: removalMode(value.mode),
    planDigest: digest(value.planDigest, 'removal request.planDigest'),
    confirmation: 'REMOVE',
  });
}

function normalizeJournalEffect(raw, index, identities) {
  const value = exactObject(raw, new Set(['item', 'identity', 'bytes', 'terminal']), `removal journal effect ${index}`);
  const identity = safeIdentity(value.identity, `removal journal effect ${index}.identity`);
  if (identities.has(identity)) throw new TypeError('removal journal effects contain duplicate identities');
  identities.add(identity);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new TypeError(`removal journal effect ${index}.bytes is invalid`);
  return Object.freeze({
    item: safeIdentity(value.item, `removal journal effect ${index}.item`),
    identity,
    bytes: value.bytes,
    terminal: boolean(value.terminal, `removal journal effect ${index}.terminal`),
  });
}

function validateEffectGroups(effects) {
  if (effects.length === 0) return;
  const completedItems = new Set();
  let activeItem = null;
  for (let index = 0; index < effects.length; index += 1) {
    const current = effects[index];
    const next = effects[index + 1] ?? null;
    if (activeItem !== current.item) {
      if (completedItems.has(current.item)) throw new TypeError('removal journal item effects are not contiguous');
      activeItem = current.item;
    }
    const groupEnds = next == null || next.item !== current.item;
    if (groupEnds !== current.terminal) throw new TypeError('removal journal item must end with one terminal effect');
    if (groupEnds) {
      completedItems.add(current.item);
      activeItem = null;
    }
  }
}

function normalizePreserved(raw, index) {
  const value = exactObject(raw, new Set(['identity', 'reasons']), `removal preserved item ${index}`);
  const reasons = uniqueIdentities(value.reasons, `removal preserved item ${index}.reasons`);
  if (reasons.length === 0) throw new TypeError('removal preserved item requires a reason');
  return Object.freeze({
    identity: safeIdentity(value.identity, `removal preserved item ${index}.identity`),
    reasons,
  });
}

export function normalizeRemovalRecord(raw) {
  if (raw == null) return null;
  const value = exactObject(
    raw,
    new Set(['protocol', 'mode', 'planDigest', 'generation', 'revision', 'cursor', 'retirementCursor', 'phase', 'attempts', 'effects', 'preserved', 'outcomes']),
    'removal journal record',
  );
  if (value.protocol !== APPLICATION_REMOVAL_PROTOCOL) throw new TypeError('removal journal protocol is unsupported');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new TypeError('removal journal revision is invalid');
  if (!Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new TypeError('removal journal cursor is invalid');
  if (!Number.isSafeInteger(value.retirementCursor) || value.retirementCursor < 0) {
    throw new TypeError('removal journal retirement cursor is invalid');
  }
  if (!PHASES.has(value.phase)) throw new TypeError('removal journal phase is invalid');
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > MAX_ATTEMPTS) {
    throw new TypeError('removal journal attempt count is invalid');
  }
  if (!Array.isArray(value.effects) || value.effects.length > MAX_EFFECTS) throw new TypeError('removal journal effects are invalid');
  const effectIdentities = new Set();
  const effects = Object.freeze(value.effects.map((entry, index) => normalizeJournalEffect(entry, index, effectIdentities)));
  validateEffectGroups(effects);
  if (!Array.isArray(value.preserved) || value.preserved.length > MAX_ITEMS) throw new TypeError('removal journal preserved items are invalid');
  const preserved = Object.freeze(value.preserved.map(normalizePreserved).sort((left, right) => left.identity.localeCompare(right.identity)));
  if (new Set(preserved.map((entry) => entry.identity)).size !== preserved.length) throw new TypeError('removal journal preserved items contain duplicates');
  const selectedItems = new Set(effects.map((entry) => entry.item));
  if (preserved.some((entry) => selectedItems.has(entry.identity))) throw new TypeError('removal journal item is both selected and preserved');
  if (!Array.isArray(value.outcomes) || value.outcomes.length !== effects.length
      || value.outcomes.some((entry) => entry !== null && !OUTCOMES.has(entry))) {
    throw new TypeError('removal journal outcomes are invalid');
  }
  if (value.cursor > effects.length) throw new TypeError('removal journal cursor exceeds its effects');
  const terminalEffects = effects.filter((effect) => effect.terminal);
  if (value.retirementCursor > terminalEffects.length) throw new TypeError('removal journal retirement cursor exceeds its effects');
  if (value.phase === 'completed') {
    if (value.cursor !== effects.length || value.retirementCursor !== terminalEffects.length
        || value.attempts !== 0 || value.outcomes.some((entry) => entry == null)) {
      throw new TypeError('completed removal journal position is invalid');
    }
  } else if (value.phase.startsWith('retirement-')) {
    if (terminalEffects.length === 0 || value.cursor !== effects.length || value.retirementCursor >= terminalEffects.length
        || value.attempts !== 0 || value.outcomes.some((entry) => entry == null)) {
      throw new TypeError('removal journal retirement position is invalid');
    }
  } else {
    if (effects.length === 0 || value.cursor >= effects.length || value.retirementCursor !== 0) {
      throw new TypeError('removal journal current effect is unavailable');
    }
    if (value.outcomes.slice(0, value.cursor).some((entry) => entry == null)
        || value.outcomes.slice(value.cursor + 1).some((entry) => entry != null)) {
      throw new TypeError('removal journal outcome frontier is invalid');
    }
    const current = value.outcomes[value.cursor];
    if (['planned', 'attempted'].includes(value.phase) ? current !== null : current == null) {
      throw new TypeError('removal journal current outcome is inconsistent');
    }
    if (value.phase === 'planned' && value.attempts !== 0) throw new TypeError('planned removal journal has attempts');
    if (value.phase === 'attempted' && value.attempts < 1) throw new TypeError('attempted removal journal has no attempt');
  }
  return Object.freeze({
    protocol: APPLICATION_REMOVAL_PROTOCOL,
    mode: removalMode(value.mode, 'removal journal mode'),
    planDigest: digest(value.planDigest, 'removal journal planDigest'),
    generation: safeIdentity(value.generation, 'removal journal generation'),
    revision: value.revision,
    cursor: value.cursor,
    retirementCursor: value.retirementCursor,
    phase: value.phase,
    attempts: value.attempts,
    effects,
    preserved,
    outcomes: Object.freeze([...value.outcomes]),
  });
}

export function normalizeRemovalObservation(raw, effect) {
  const value = exactObject(raw, new Set(['identity', 'state', 'retryable']), 'removal effect observation');
  if (value.identity !== effect.identity) throw new TypeError('removal effect observation identity changed');
  if (!['present', 'absent', 'ambiguous'].includes(value.state)) throw new TypeError('removal effect observation state is invalid');
  return Object.freeze({
    identity: value.identity,
    state: value.state,
    retryable: boolean(value.retryable, 'removal effect observation.retryable'),
  });
}

export function normalizeRemovalBinding(raw, input) {
  const value = exactObject(raw, new Set(['protocol', 'mode', 'item', 'identity', 'planDigest', 'bound']), 'removal effect binding');
  if (value.protocol !== APPLICATION_REMOVAL_PROTOCOL || value.mode !== input.mode || value.item !== input.item
      || value.identity !== input.effect.identity || value.planDigest !== input.planDigest || value.bound !== true) {
    throw new TypeError('removal effect binding did not preserve exact authority');
  }
  return Object.freeze({ ...value });
}

export function normalizeRemovalRetirement(raw, effect) {
  const value = exactObject(raw, new Set(['identity', 'retired']), 'removal effect retirement');
  if (value.identity !== effect.identity || value.retired !== true) {
    throw new TypeError('removal effect retirement did not preserve exact authority');
  }
  return Object.freeze({ identity: value.identity, retired: true });
}

export function maximumRemovalAttempts() {
  return MAX_ATTEMPTS;
}
