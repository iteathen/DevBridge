import { ExactCheckoutRunnerProvider } from './exact-checkout-runner-provider.mjs';
import { normalizeRunnerSubject } from './permanent-entry.mjs';

function fail(message) { throw new Error(message); }

function providerOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  if (Object.hasOwn(options, 'admitSubject') || Object.hasOwn(options, 'normalizeSubject')) fail('development checkout admission is fixed locally');
  return {
    ...options,
    normalizeSubject: normalizeRunnerSubject,
    admitSubject(subject) {
      if (subject.channel !== 'stable' || subject.releaseId !== `development-${subject.head}`) {
        fail('development checkout provider requires exact development authority');
      }
    },
  };
}

export class DevelopmentCheckoutRunnerProvider {
  #provider;

  constructor(options = {}) {
    this.#provider = new ExactCheckoutRunnerProvider(providerOptions(options));
  }

  prepare(subject) {
    return this.#provider.prepare(subject);
  }
}
