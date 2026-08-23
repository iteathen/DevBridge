import {
  normalizeUbuntuReleaseMediaAuthority,
  requireUbuntuReleaseMediaAuthoritySubject,
  ubuntuReleaseMediaAuthoritySubject,
} from './ubuntu-release-media-authority.js';

export class UbuntuReleaseMediaAuthorityCatalog {
  #store;
  #allowedHosts;

  constructor({ store, allowedHosts } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.list !== 'function') {
      throw new TypeError('release media authority store contract is incomplete');
    }
    this.#store = store;
    this.#allowedHosts = allowedHosts;
  }

  #normalize(raw) {
    return normalizeUbuntuReleaseMediaAuthority(raw, this.#allowedHosts === undefined ? undefined : { allowedHosts: this.#allowedHosts });
  }

  #subject(raw) {
    return ubuntuReleaseMediaAuthoritySubject(raw, this.#allowedHosts === undefined ? undefined : { allowedHosts: this.#allowedHosts });
  }

  async register(rawAuthority) {
    const authority = this.#normalize(rawAuthority);
    const subjectRef = this.#subject(authority);
    const existing = await this.#store.load(subjectRef);
    if (existing !== undefined) {
      const normalizedExisting = this.#normalize(existing);
      if (this.#subject(normalizedExisting) !== subjectRef) throw new Error('stored release media authority identity is corrupt');
      return Object.freeze({ subjectRef, authority: normalizedExisting, created: false });
    }
    await this.#store.save(subjectRef, authority);
    return Object.freeze({ subjectRef, authority, created: true });
  }

  async lookup(rawSubjectRef) {
    const subjectRef = requireUbuntuReleaseMediaAuthoritySubject(rawSubjectRef);
    const stored = await this.#store.load(subjectRef);
    if (stored === undefined) return null;
    const authority = this.#normalize(stored);
    if (this.#subject(authority) !== subjectRef) throw new Error('stored release media authority identity is corrupt');
    return authority;
  }

  async list() {
    const entries = await this.#store.list();
    if (!Array.isArray(entries)) throw new TypeError('release media authority store list result is invalid');
    const authorities = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('release media authority store entry is invalid');
      const subjectRef = requireUbuntuReleaseMediaAuthoritySubject(entry.subjectRef);
      const authority = this.#normalize(entry.value);
      if (this.#subject(authority) !== subjectRef) throw new Error('stored release media authority identity is corrupt');
      authorities.push(Object.freeze({ subjectRef, authority }));
    }
    authorities.sort((left, right) => left.subjectRef.localeCompare(right.subjectRef));
    return Object.freeze(authorities);
  }
}

export function createUbuntuReleaseMediaAuthorityCatalog(options) {
  return new UbuntuReleaseMediaAuthorityCatalog(options);
}
