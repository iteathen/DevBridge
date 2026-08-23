import {
  normalizeUbuntuConstructionAuthority,
  requireUbuntuConstructionAuthoritySubject,
  ubuntuConstructionAuthoritySubject,
} from './ubuntu-construction-authority.js';

export class UbuntuConstructionAuthorityCatalog {
  #store;

  constructor({ store } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.list !== 'function') {
      throw new TypeError('construction authority store contract is incomplete');
    }
    this.#store = store;
  }

  async register(rawAuthority) {
    const authority = normalizeUbuntuConstructionAuthority(rawAuthority);
    const subjectRef = ubuntuConstructionAuthoritySubject(authority);
    const existing = await this.#store.load(subjectRef);
    if (existing !== undefined) {
      const normalizedExisting = normalizeUbuntuConstructionAuthority(existing);
      if (ubuntuConstructionAuthoritySubject(normalizedExisting) !== subjectRef) throw new Error('stored construction authority identity is corrupt');
      return Object.freeze({ subjectRef, authority: normalizedExisting, created: false });
    }
    await this.#store.save(subjectRef, authority);
    return Object.freeze({ subjectRef, authority, created: true });
  }

  async lookup(rawSubjectRef) {
    const subjectRef = requireUbuntuConstructionAuthoritySubject(rawSubjectRef);
    const stored = await this.#store.load(subjectRef);
    if (stored === undefined) return null;
    const authority = normalizeUbuntuConstructionAuthority(stored);
    if (ubuntuConstructionAuthoritySubject(authority) !== subjectRef) throw new Error('stored construction authority identity is corrupt');
    return authority;
  }

  async list() {
    const entries = await this.#store.list();
    if (!Array.isArray(entries)) throw new TypeError('construction authority store list result is invalid');
    const authorities = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('construction authority store entry is invalid');
      const subjectRef = requireUbuntuConstructionAuthoritySubject(entry.subjectRef);
      const authority = normalizeUbuntuConstructionAuthority(entry.value);
      if (ubuntuConstructionAuthoritySubject(authority) !== subjectRef) throw new Error('stored construction authority identity is corrupt');
      authorities.push(Object.freeze({ subjectRef, authority }));
    }
    authorities.sort((left, right) => left.subjectRef.localeCompare(right.subjectRef));
    return Object.freeze(authorities);
  }
}

export function createUbuntuConstructionAuthorityCatalog(options) {
  return new UbuntuConstructionAuthorityCatalog(options);
}
