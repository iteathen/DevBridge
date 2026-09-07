import { verifySourceBundleReleaseInput } from './source-bundle-release-input.mjs';

const EXACT_HEAD = /^[a-f0-9]{40}$/u;

function fail(message) { throw new Error(message); }

function exactRequest(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unsupported`);
  return raw;
}

export class SourceBundleAvailability {
  #authority;
  #head;
  #materialization;

  constructor({ authority, materialization } = {}) {
    const verified = verifySourceBundleReleaseInput(authority);
    if (!materialization || typeof materialization.prepare !== 'function') {
      throw new TypeError('source-bundle materialization port is invalid');
    }
    this.#authority = authority;
    this.#head = verified.head;
    this.#materialization = materialization;
  }

  async prepare(raw) {
    const input = exactRequest(raw, new Set(['head', 'destination', 'signal']), 'source-bundle source request');
    const head = String(input.head ?? '').toLowerCase();
    if (!EXACT_HEAD.test(head)) throw new TypeError('source-bundle source head is invalid');
    if (head !== this.#head) fail('source-bundle source does not match the requested exact head');
    const prepared = await this.#materialization.prepare({
      authority: this.#authority,
      destination: input.destination,
      signal: input.signal ?? null,
    });
    if (prepared?.head !== head) fail('source-bundle source does not match the requested exact head');
    return prepared;
  }

  async materialize(raw) {
    const input = exactRequest(raw, new Set(['subject', 'destination', 'signal']), 'source-bundle checkout request');
    const head = String(input.subject?.head ?? '').toLowerCase();
    return this.prepare({ head, destination: input.destination, signal: input.signal ?? null });
  }
}
