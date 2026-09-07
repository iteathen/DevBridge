import { createHash } from 'node:crypto';

export const WINDOWS_INSTALL_MEDIA_SELECTION_STATE_PROTOCOL = 'devbridge/windows-install-media-selection-state-v1';
export const WINDOWS_INSTALL_MEDIA_SELECTION_STATUS_PROTOCOL = 'devbridge/windows-install-media-selection-status-v1';

export const WINDOWS_INSTALL_MEDIA_ACQUISITION = Object.freeze({
  officialOwned: 'https://www.microsoft.com/en-us/software-download/windows11',
  evaluation: 'https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise',
});

const CANDIDATE = /^candidate-[a-f0-9]{32}$/u;
const SOURCE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const SOURCE_CLASSES = new Set(['official-owned', 'evaluation']);
const MAX_SOURCES = 16;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function sourceReference(value) {
  if (typeof value !== 'string' || !SOURCE.test(value)) throw new TypeError('install media source reference is invalid');
  return value;
}

function candidateSubject(source, inventory) {
  return `candidate-${digest({ source, inventory }).slice(0, 32)}`;
}

function normalizeCandidate(raw, normalizeInventory) {
  const value = onlyKeys(raw, new Set(['subject', 'source', 'inventory']), 'install media candidate');
  const source = sourceReference(value.source);
  const inventory = normalizeInventory(value.inventory);
  const subject = candidateSubject(source, inventory);
  if (value.subject !== subject || !CANDIDATE.test(value.subject)) throw new Error('install media candidate identity is invalid');
  return Object.freeze({ subject, source, inventory });
}

function normalizeAccepted(raw) {
  if (raw == null) return null;
  const value = onlyKeys(raw, new Set(['candidate', 'source', 'authority']), 'accepted install media selection');
  if (typeof value.candidate !== 'string' || !CANDIDATE.test(value.candidate)) throw new TypeError('accepted install media candidate is invalid');
  return Object.freeze({
    candidate: value.candidate,
    source: sourceReference(value.source),
    authority: authorityReference(value.authority),
  });
}

function authorityReference(value) {
  if (typeof value !== 'string' || !/^subject-[a-f0-9]{32}$/u.test(value)) throw new TypeError('install media authority reference is invalid');
  return value;
}

function normalizeState(raw, normalizeInventory) {
  if (raw == null) return Object.freeze({ protocol: WINDOWS_INSTALL_MEDIA_SELECTION_STATE_PROTOCOL, candidates: Object.freeze([]), rejectedCount: 0, accepted: null });
  const value = onlyKeys(raw, new Set(['protocol', 'candidates', 'rejectedCount', 'accepted']), 'install media selection state');
  if (value.protocol !== WINDOWS_INSTALL_MEDIA_SELECTION_STATE_PROTOCOL) throw new TypeError('install media selection state protocol is unsupported');
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_SOURCES) throw new TypeError('install media selection candidates are invalid');
  const candidates = value.candidates.map((candidate) => normalizeCandidate(candidate, normalizeInventory));
  const subjects = new Set(candidates.map((entry) => entry.subject));
  if (subjects.size !== candidates.length) throw new Error('install media selection contains duplicate candidates');
  if (!Number.isSafeInteger(value.rejectedCount) || value.rejectedCount < 0 || value.rejectedCount > MAX_SOURCES) throw new TypeError('install media rejected count is invalid');
  return Object.freeze({
    protocol: WINDOWS_INSTALL_MEDIA_SELECTION_STATE_PROTOCOL,
    candidates: Object.freeze(candidates.sort((left, right) => left.subject.localeCompare(right.subject))),
    rejectedCount: value.rejectedCount,
    accepted: normalizeAccepted(value.accepted),
  });
}

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

function normalizeSourceList(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_SOURCES) throw new TypeError('install media source list is invalid');
  const seen = new Set();
  return Object.freeze(raw.map((entry) => {
    const value = onlyKeys(entry, new Set(['reference', 'name', 'bytes']), 'install media source');
    const reference = sourceReference(value.reference);
    if (seen.has(reference)) throw new Error('install media source list contains a duplicate reference');
    seen.add(reference);
    return reference;
  }));
}

function normalizeApproval(raw) {
  const value = onlyKeys(raw, new Set(['candidate', 'imageIndex', 'sourceClass']), 'install media approval request');
  if (typeof value.candidate !== 'string' || !CANDIDATE.test(value.candidate)) throw new TypeError('install media approval candidate is invalid');
  if (!Number.isSafeInteger(value.imageIndex) || value.imageIndex < 1 || value.imageIndex > 512) throw new TypeError('install media approval imageIndex is invalid');
  if (typeof value.sourceClass !== 'string' || !SOURCE_CLASSES.has(value.sourceClass)) throw new TypeError('install media approval sourceClass is invalid');
  return Object.freeze({ candidate: value.candidate, imageIndex: value.imageIndex, sourceClass: value.sourceClass });
}

function publicCandidate(value) {
  return Object.freeze({ subject: value.subject, media: value.inventory.media, images: value.inventory.images });
}

export class WindowsInstallMediaSelection {
  #source;
  #catalog;
  #state;
  #normalizeInventory;
  #createAuthority;

  constructor({ source, catalog, state, normalizeInventory, createAuthority } = {}) {
    this.#source = requirePort(source, ['list', 'inventory', 'resolve'], 'install media source');
    this.#catalog = requirePort(catalog, ['register', 'lookup'], 'install media authority catalog');
    this.#state = requirePort(state, ['load', 'save'], 'install media selection state');
    if (typeof normalizeInventory !== 'function' || typeof createAuthority !== 'function') throw new TypeError('install media selection value ports are incomplete');
    this.#normalizeInventory = normalizeInventory;
    this.#createAuthority = createAuthority;
  }

  async #accepted(state) {
    if (state.accepted == null) return null;
    const candidate = state.candidates.find((entry) => entry.subject === state.accepted.candidate && entry.source === state.accepted.source);
    if (candidate == null) throw new Error('accepted install media candidate is unavailable');
    const authority = await this.#catalog.lookup(state.accepted.authority);
    if (authority == null) throw new Error('accepted install media authority is unavailable');
    const candidateImage = candidate.inventory.images.find((entry) => entry.index === authority.image.index);
    if (digest(authority.media) !== digest(candidate.inventory.media) || candidateImage == null || digest(authority.image) !== digest(candidateImage)) {
      throw new Error('accepted install media authority does not match its candidate');
    }
    const source = await this.#source.resolve(state.accepted.source);
    if (!source || source.name !== authority.media.name || source.bytes !== authority.media.bytes) throw new Error('accepted install media source identity changed');
    return Object.freeze({ candidate, authority, source });
  }

  async #status(state) {
    const binding = await this.#accepted(state);
    const accepted = binding == null ? null : Object.freeze({
      candidate: state.accepted.candidate,
      authority: state.accepted.authority,
      media: binding.authority.media,
      image: binding.authority.image,
      sourceClass: binding.authority.approval.sourceClass,
      temporary: binding.authority.approval.temporary,
    });
    return Object.freeze({
      protocol: WINDOWS_INSTALL_MEDIA_SELECTION_STATUS_PROTOCOL,
      state: accepted ? 'accepted' : state.candidates.length > 0 ? 'selection-required' : 'source-required',
      candidates: Object.freeze(state.candidates.map(publicCandidate)),
      rejectedCount: state.rejectedCount,
      accepted,
      acquisition: WINDOWS_INSTALL_MEDIA_ACQUISITION,
    });
  }

  async status() { return this.#status(normalizeState(await this.#state.load(), this.#normalizeInventory)); }

  async discover() {
    const previous = normalizeState(await this.#state.load(), this.#normalizeInventory);
    const references = normalizeSourceList(await this.#source.list());
    const candidates = [];
    let rejectedCount = 0;
    for (const reference of references) {
      try {
        const inventory = this.#normalizeInventory(await this.#source.inventory(reference));
        candidates.push(normalizeCandidate({ subject: candidateSubject(reference, inventory), source: reference, inventory }, this.#normalizeInventory));
      } catch {
        rejectedCount += 1;
      }
    }
    const accepted = previous.accepted != null && candidates.some((entry) => (
      entry.subject === previous.accepted.candidate && entry.source === previous.accepted.source
    )) ? previous.accepted : null;
    const next = normalizeState({
      protocol: WINDOWS_INSTALL_MEDIA_SELECTION_STATE_PROTOCOL,
      candidates,
      rejectedCount,
      accepted,
    }, this.#normalizeInventory);
    await this.#state.save(next);
    return this.#status(next);
  }

  async approve(rawApproval) {
    const approval = normalizeApproval(rawApproval);
    const previous = normalizeState(await this.#state.load(), this.#normalizeInventory);
    const candidate = previous.candidates.find((entry) => entry.subject === approval.candidate);
    if (!candidate) throw new Error('install media approval candidate is unavailable; discover current media first');
    const observedInventory = this.#normalizeInventory(await this.#source.inventory(candidate.source));
    const observed = normalizeCandidate({ subject: candidateSubject(candidate.source, observedInventory), source: candidate.source, inventory: observedInventory }, this.#normalizeInventory);
    if (observed.subject !== candidate.subject) throw new Error('install media candidate changed after discovery');
    const image = observed.inventory.images.find((entry) => entry.index === approval.imageIndex);
    if (!image) throw new Error('install media approval image is unavailable');
    const source = await this.#source.resolve(observed.source);
    if (!source || source.name !== observed.inventory.media.name || source.bytes !== observed.inventory.media.bytes) throw new Error('install media source identity changed during approval');
    const evaluation = approval.sourceClass === 'evaluation';
    const authority = this.#createAuthority({
      media: observed.inventory.media,
      image,
      sourceClass: approval.sourceClass,
      reference: evaluation ? WINDOWS_INSTALL_MEDIA_ACQUISITION.evaluation : WINDOWS_INSTALL_MEDIA_ACQUISITION.officialOwned,
      temporary: evaluation,
    });
    const registered = await this.#catalog.register(authority);
    const next = normalizeState({
      ...previous,
      accepted: { candidate: observed.subject, source: observed.source, authority: registered.subjectRef },
    }, this.#normalizeInventory);
    await this.#state.save(next);
    return this.#status(next);
  }

  async resolve() {
    const state = normalizeState(await this.#state.load(), this.#normalizeInventory);
    const binding = await this.#accepted(state);
    if (binding == null) return null;
    if (typeof binding.source.location !== 'string' || binding.source.location.length === 0) throw new Error('accepted install media source is unavailable');
    return Object.freeze({ location: binding.source.location, authority: binding.authority });
  }
}

export function createWindowsInstallMediaSelection(options) {
  return new WindowsInstallMediaSelection(options);
}
