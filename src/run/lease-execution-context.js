import { AsyncLocalStorage } from 'node:async_hooks';

export class LeaseExecutionContext {
  #manager;
  #storage = new AsyncLocalStorage();

  constructor({ taskLeaseManager }) {
    if (!taskLeaseManager || typeof taskLeaseManager.assertOwned !== 'function') throw new TypeError('LeaseExecutionContext requires a task lease manager');
    this.#manager = taskLeaseManager;
  }

  run(handle, callback) {
    this.#manager.assertOwned(handle);
    return this.#storage.run(handle, callback);
  }

  #active() {
    const handle = this.#storage.getStore() ?? null;
    if (handle) this.#manager.assertOwned(handle);
    return handle;
  }

  async #freshSensitiveLease() {
    const handle = this.#active();
    if (!handle) return null;
    if (typeof this.#manager.ensureFresh === 'function') await this.#manager.ensureFresh(handle);
    else await this.#manager.renew(handle);
    this.#manager.assertOwned(handle);
    return handle;
  }

  wrapProcessRunner(delegate) {
    if (!delegate || typeof delegate.run !== 'function') throw new TypeError('lease process wrapper requires a process runner');
    return {
      run: async (request) => {
        const handle = this.#active();
        const result = await delegate.run(handle ? { ...request, signal: handle.signal } : request);
        if (handle) this.#manager.assertOwned(handle);
        return result;
      },
      recoverResult: typeof delegate.recoverResult === 'function'
        ? async (request) => {
            const handle = this.#active();
            const result = await delegate.recoverResult(request);
            if (handle) this.#manager.assertOwned(handle);
            return result;
          }
        : undefined,
    };
  }

  wrapWorkspaceManager(delegate) {
    if (!delegate || typeof delegate.prepareRun !== 'function') throw new TypeError('lease workspace wrapper requires a workspace manager');
    const guarded = async (method, args, { refresh = false } = {}) => {
      const handle = refresh ? await this.#freshSensitiveLease() : this.#active();
      const result = await delegate[method](...args);
      if (handle) this.#manager.assertOwned(handle);
      return result;
    };
    return {
      prepareRun: (...args) => guarded('prepareRun', args),
      snapshot: (...args) => guarded('snapshot', args),
      validate: (...args) => guarded('validate', args),
      sealCandidate: (...args) => guarded('sealCandidate', args, { refresh: true }),
      publishTaskBranch: (...args) => guarded('publishTaskBranch', args, { refresh: true }),
    };
  }
}
