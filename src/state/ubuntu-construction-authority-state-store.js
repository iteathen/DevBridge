import { JsonStateStore } from './json-state-store.js';
import {
  normalizeUbuntuConstructionAuthority,
  requireUbuntuConstructionAuthoritySubject,
  ubuntuConstructionAuthoritySubject,
} from '../runtime/image-builders/ubuntu-construction-authority.js';

const KEY_PREFIX = 'authority:';

function authorityKey(subjectRef) {
  return `${KEY_PREFIX}${requireUbuntuConstructionAuthoritySubject(subjectRef)}`;
}

export class UbuntuConstructionAuthorityStateStore {
  #store;

  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('construction authority state file is required');
    this.#store = new JsonStateStore(filePath);
  }

  async register(rawAuthority) {
    const authority = normalizeUbuntuConstructionAuthority(rawAuthority);
    const subjectRef = ubuntuConstructionAuthoritySubject(authority);
    const key = authorityKey(subjectRef);
    const existing = await this.#store.get(key);
    if (existing !== undefined) {
      const normalizedExisting = normalizeUbuntuConstructionAuthority(existing);
      if (ubuntuConstructionAuthoritySubject(normalizedExisting) !== subjectRef) throw new Error('stored construction authority identity is corrupt');
      return Object.freeze({ subjectRef, authority: normalizedExisting, created: false });
    }
    await this.#store.set(key, authority);
    return Object.freeze({ subjectRef, authority, created: true });
  }

  async lookup(rawSubjectRef) {
    const subjectRef = requireUbuntuConstructionAuthoritySubject(rawSubjectRef);
    const stored = await this.#store.get(authorityKey(subjectRef));
    if (stored === undefined) return null;
    const authority = normalizeUbuntuConstructionAuthority(stored);
    if (ubuntuConstructionAuthoritySubject(authority) !== subjectRef) throw new Error('stored construction authority identity is corrupt');
    return authority;
  }

  async list() {
    const entries = await this.#store.entries(KEY_PREFIX);
    const authorities = [];
    for (const [key, stored] of entries) {
      const subjectRef = requireUbuntuConstructionAuthoritySubject(key.slice(KEY_PREFIX.length));
      const authority = normalizeUbuntuConstructionAuthority(stored);
      if (ubuntuConstructionAuthoritySubject(authority) !== subjectRef) throw new Error('stored construction authority identity is corrupt');
      authorities.push(Object.freeze({ subjectRef, authority }));
    }
    authorities.sort((left, right) => left.subjectRef.localeCompare(right.subjectRef));
    return Object.freeze(authorities);
  }
}

export function createUbuntuConstructionAuthorityStateStore(filePath) {
  return new UbuntuConstructionAuthorityStateStore(filePath);
}
