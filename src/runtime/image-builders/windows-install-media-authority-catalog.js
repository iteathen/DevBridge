import {
  normalizeWindowsInstallMediaAuthority,
  requireWindowsInstallMediaAuthoritySubject,
  windowsInstallMediaAuthoritySubject,
} from './windows-install-media-authority.js';

export class WindowsInstallMediaAuthorityCatalog {
  #store;

  constructor({ store } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.list !== 'function') {
      throw new TypeError('install media authority store contract is incomplete');
    }
    this.#store = store;
  }

  async register(rawAuthority) {
    const authority = normalizeWindowsInstallMediaAuthority(rawAuthority);
    const subjectRef = windowsInstallMediaAuthoritySubject(authority);
    const existing = await this.#store.load(subjectRef);
    if (existing !== undefined) {
      const normalizedExisting = normalizeWindowsInstallMediaAuthority(existing);
      if (windowsInstallMediaAuthoritySubject(normalizedExisting) !== subjectRef) throw new Error('stored install media authority identity is corrupt');
      return Object.freeze({ subjectRef, authority: normalizedExisting, created: false });
    }
    await this.#store.save(subjectRef, authority);
    return Object.freeze({ subjectRef, authority, created: true });
  }

  async lookup(rawSubjectRef) {
    const subjectRef = requireWindowsInstallMediaAuthoritySubject(rawSubjectRef);
    const stored = await this.#store.load(subjectRef);
    if (stored === undefined) return null;
    const authority = normalizeWindowsInstallMediaAuthority(stored);
    if (windowsInstallMediaAuthoritySubject(authority) !== subjectRef) throw new Error('stored install media authority identity is corrupt');
    return authority;
  }

  async list() {
    const entries = await this.#store.list();
    if (!Array.isArray(entries)) throw new TypeError('install media authority store list result is invalid');
    const result = entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('install media authority store entry is invalid');
      const subjectRef = requireWindowsInstallMediaAuthoritySubject(entry.subjectRef);
      const authority = normalizeWindowsInstallMediaAuthority(entry.value);
      if (windowsInstallMediaAuthoritySubject(authority) !== subjectRef) throw new Error('stored install media authority identity is corrupt');
      return Object.freeze({ subjectRef, authority });
    });
    result.sort((left, right) => left.subjectRef.localeCompare(right.subjectRef));
    return Object.freeze(result);
  }
}

export function createWindowsInstallMediaAuthorityCatalog(options) {
  return new WindowsInstallMediaAuthorityCatalog(options);
}
