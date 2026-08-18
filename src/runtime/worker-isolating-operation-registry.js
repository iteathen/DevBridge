import { PolicyError } from '../errors.js';

export class WorkerIsolatingOperationRegistry {
  #delegate;

  constructor({ delegate }) {
    if (!delegate || typeof delegate.execute !== 'function' || typeof delegate.describe !== 'function') {
      throw new TypeError('worker-isolating operation registry delegate is required');
    }
    this.#delegate = delegate;
  }

  has(name) { return this.#delegate.has(name); }
  names() { return this.#delegate.names(); }
  describe(options) { return this.#delegate.describe(options); }
  validate(name, params) { return this.#delegate.validate(name, params); }

  #descriptor(name) {
    const descriptor = this.#delegate.describe().find((entry) => entry.name === name);
    if (!descriptor) throw new PolicyError(`controller plan references unregistered operation ${name}`);
    return descriptor;
  }

  async execute(name, params, context) {
    const descriptor = this.#descriptor(name);
    if (descriptor.executionClass !== 'repository-code-executing') {
      return this.#delegate.execute(name, params, context);
    }
    if (!context?.scratch || typeof context.scratch.projectMirror !== 'function') {
      throw new PolicyError(`repository-code operation ${name} requires a disposable worker project mirror`);
    }
    const authoritativeProjectDir = context.projectDir;
    const projectDir = await context.scratch.projectMirror(authoritativeProjectDir);
    return this.#delegate.execute(name, params, {
      ...context,
      projectDir,
      authoritativeProjectDir,
    });
  }
}
