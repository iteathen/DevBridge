import {
  normalizeWindowsProductionImageAuthority,
  requireWindowsProductionImageAuthoritySubject,
  windowsProductionImageAuthoritySubject,
} from './windows-production-image-authority.js';

export class WindowsProductionImageAuthorityCatalog {
  #store;

  constructor({ store } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new TypeError('production image authority store contract is incomplete');
    this.#store = store;
  }

  async register(raw) {
    const authority = normalizeWindowsProductionImageAuthority(raw);
    const subjectRef = windowsProductionImageAuthoritySubject(authority);
    const existing = await this.#store.load(subjectRef);
    if (existing !== undefined) {
      const normalized = normalizeWindowsProductionImageAuthority(existing);
      if (windowsProductionImageAuthoritySubject(normalized) !== subjectRef) throw new Error('stored production image authority identity is corrupt');
      return Object.freeze({ subjectRef, authority: normalized, created: false });
    }
    await this.#store.save(subjectRef, authority);
    return Object.freeze({ subjectRef, authority, created: true });
  }

  async lookup(rawSubjectRef) {
    const subjectRef = requireWindowsProductionImageAuthoritySubject(rawSubjectRef);
    const stored = await this.#store.load(subjectRef);
    if (stored === undefined) return null;
    const authority = normalizeWindowsProductionImageAuthority(stored);
    if (windowsProductionImageAuthoritySubject(authority) !== subjectRef) throw new Error('stored production image authority identity is corrupt');
    return authority;
  }
}

export function createWindowsProductionImageAuthorityCatalog(options) {
  return new WindowsProductionImageAuthorityCatalog(options);
}
