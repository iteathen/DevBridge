import { createHyperVEnvironmentLocation } from './hyperv-environment-location.js';
import { copyHyperVGuestFile } from './hyperv-file-copy.js';

const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;

function bounded(value, name, maxBytes = 4096) { if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) throw new TypeError(`${name} is invalid`); return value; }

export class HyperVGuestFileDelivery {
  #invoke;
  #location;
  #family;
  constructor({ identity, invoke, family = 'linux' } = {}) {
    if (typeof invoke !== 'function' || !['linux', 'windows'].includes(family)) throw new TypeError('guest file delivery invocation contract is invalid');
    this.#invoke = invoke;
    this.#location = createHyperVEnvironmentLocation(identity);
    this.#family = family;
  }

  async put(rawTarget, source, destination) {
    const target = bounded(rawTarget, 'guest file delivery target', 512);
    if (!TARGET.test(target)) throw new TypeError('guest file delivery target is invalid');
    return copyHyperVGuestFile({ invoke: this.#invoke, location: this.#location.environment(target), family: this.#family, source, destination });
  }
}
