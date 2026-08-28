export function createTransactionManager({
  protocol,
  defaultNow,
  defaultId,
  normalizeIdentifier,
  normalizeValidation,
  normalizeRecord,
  createInitialValue,
  replaceSelection,
  replaceEntry,
  importValue,
  evaluateBlockers,
} = {}) {
  return class SetupAuthorityManager {
    #port;
    #now;
    #id;

    constructor({ port, now = defaultNow, id = defaultId } = {}) {
      if (!port || typeof port.load !== 'function' || typeof port.save !== 'function') throw new TypeError('setup authority persistence port is incomplete');
      if (typeof now !== 'function' || typeof id !== 'function') throw new TypeError('setup authority dependencies are invalid');
      this.#port = port;
      this.#now = now;
      this.#id = id;
    }

    async current() {
      const raw = await this.#port.load();
      return raw == null ? null : normalizeRecord(raw);
    }

    async begin() {
      const current = await this.current();
      if (current?.working) return Object.freeze({ resumed: true, record: current });
      const now = this.#now();
      const revision = current?.revision ?? 0;
      const accepted = current?.accepted ?? null;
      const next = normalizeRecord({
        protocol,
        revision,
        accepted,
        working: {
          operationId: normalizeIdentifier(this.#id(), 'setup authority operation identity'),
          baseRevision: revision,
          snapshot: accepted ?? createInitialValue(),
          validation: 'pending',
          updatedAt: now,
        },
        updatedAt: now,
      });
      await this.#port.save(next);
      return Object.freeze({ resumed: false, record: next });
    }

    async #working(operationId) {
      const current = await this.current();
      if (!current?.working) throw new Error('setup authority working generation does not exist');
      if (current.working.operationId !== normalizeIdentifier(operationId, 'setup authority operation identity')) {
        throw new Error('setup authority operation identity does not match current working generation');
      }
      return current;
    }

    async #saveEdit(current, snapshot) {
      const now = this.#now();
      const next = normalizeRecord({
        ...current,
        working: { ...current.working, snapshot, validation: 'pending', updatedAt: now },
        updatedAt: now,
      });
      await this.#port.save(next);
      return next;
    }

    async replaceProfiles(operationId, input) {
      const current = await this.#working(operationId);
      return this.#saveEdit(current, replaceSelection(current.working.snapshot, input));
    }

    async replaceAuthority(operationId, authority) {
      const current = await this.#working(operationId);
      return this.#saveEdit(current, replaceEntry(current.working.snapshot, authority));
    }

    async importTemplate(operationId, template) {
      const current = await this.#working(operationId);
      return this.#saveEdit(current, importValue(template));
    }

    async markValidation(operationId, outcome) {
      const current = await this.#working(operationId);
      const validation = normalizeValidation(outcome);
      if (validation === 'pending') throw new TypeError('setup authority validation outcome must be terminal for this working generation');
      if (validation === 'passed') {
        const blockers = evaluateBlockers(current.working.snapshot);
        if (blockers.length > 0) throw new Error(`setup authority working generation has unresolved blockers: ${blockers.map((entry) => entry.code).join(', ')}`);
      }
      const now = this.#now();
      const next = normalizeRecord({
        ...current,
        working: { ...current.working, validation, updatedAt: now },
        updatedAt: now,
      });
      await this.#port.save(next);
      return next;
    }

    async commit(operationId) {
      const current = await this.#working(operationId);
      if (current.working.validation !== 'passed') throw new Error('setup authority working generation is not validated');
      if (current.working.baseRevision !== current.revision) throw new Error('setup authority accepted revision changed; re-read before commit');
      const now = this.#now();
      const next = normalizeRecord({
        protocol,
        revision: current.revision + 1,
        accepted: current.working.snapshot,
        working: null,
        updatedAt: now,
      });
      await this.#port.save(next);
      return next;
    }

    async discard(operationId) {
      const current = await this.#working(operationId);
      const now = this.#now();
      const next = normalizeRecord({ ...current, working: null, updatedAt: now });
      await this.#port.save(next);
      return next;
    }
  };
}
