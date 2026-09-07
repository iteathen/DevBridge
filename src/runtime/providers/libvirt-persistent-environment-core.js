import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeBootProtection } from '../../values/boot-protection.js';
import { LibvirtEnvironmentContract } from './libvirt-persistent-environment/environment-contract.js';
import { LibvirtEnvironmentLedger } from './libvirt-persistent-environment/state-ledger.js';
import { LibvirtDomainChannel } from './libvirt-persistent-environment/domain-channel.js';
import { LibvirtOverlayLineage } from './libvirt-persistent-environment/overlay-lineage.js';

export class LibvirtPersistentEnvironment {
  #contract;
  #ledger;
  #domain;
  #overlay;

  constructor({ directory, sourceRoot, identity, invoke }) {
    this.#contract = new LibvirtEnvironmentContract({
      directory,
      sourceRoot,
      identity,
      normalizeProtection: normalizeBootProtection,
    });
    this.#ledger = new LibvirtEnvironmentLedger({ directory });
    this.#domain = new LibvirtDomainChannel({ invoke });
    this.#overlay = new LibvirtOverlayLineage({ invoke });
  }

  async inspect() { return { identity: this.#contract.binding() }; }

  async provision(raw) {
    const input = this.#contract.request(raw);
    const identity = input.identity;
    const descriptor = this.#contract.descriptor(identity);
    const admitted = await this.#contract.source(input.source);
    const settings = this.#contract.settings(input.settings);
    const state = await this.#ledger.load();
    const record = {
      identity,
      sourceIdentity: admitted.identity,
      sourceRevision: admitted.revision,
      sourceDigest: admitted.digest,
      parentPath: admitted.location,
      parentFileIdentity: admitted.fileIdentity,
      diskPath: descriptor.diskPath,
      diskFileIdentity: null,
      name: descriptor.name,
      uuid: descriptor.uuid,
      marker: descriptor.marker,
      settings: structuredClone(settings),
    };
    const existing = this.#contract.record(state, identity);
    if (existing) {
      const comparableExisting = { ...existing, diskFileIdentity: null };
      if (JSON.stringify(comparableExisting) !== JSON.stringify(record)) throw new Error('environment adapter record conflicts with the requested lineage');
    } else {
      state.records[identity] = record;
      await this.#ledger.save(state);
    }

    await mkdir(descriptor.local, { recursive: true, mode: 0o700 });
    const localInfo = await lstat(descriptor.local);
    if (!localInfo.isDirectory() || localInfo.isSymbolicLink()) throw new Error('environment object directory must be a real directory');
    try {
      const info = await lstat(descriptor.diskPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('environment writable state shape changed');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.#overlay.create(admitted.location, descriptor.diskPath);
    }
    const storage = await this.#overlay.observe(state.records[identity]);
    if (!storage.compatible) throw new Error(storage.reason);
    if (!state.records[identity].diskFileIdentity) {
      state.records[identity].diskFileIdentity = storage.fileIdentity;
      await this.#ledger.save(state);
    }

    const domain = await this.#domain.observe(state.records[identity]);
    if (domain.exists && (!domain.owned || !domain.compatible)) throw new Error(domain.reason ?? 'existing environment configuration is incompatible');
    if (!domain.exists) {
      const definition = path.join(descriptor.local, 'definition.xml');
      await writeFile(definition, this.#contract.definition(record, settings), { encoding: 'utf8', mode: 0o600 });
      try { await this.#domain.define(definition); }
      finally { await rm(definition, { force: true }); }
    }
    return this.observe(identity);
  }

  async observe(identity) {
    this.#contract.descriptor(identity);
    const state = await this.#ledger.load();
    const record = this.#contract.record(state, identity);
    if (!record) return { identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'environment adapter record is absent', storage: null };
    const domain = await this.#domain.observe(record);
    const storage = await this.#overlay.observe(record);
    return {
      identity,
      exists: domain.exists,
      owned: domain.owned,
      compatible: domain.compatible && storage.compatible,
      state: domain.state,
      reason: domain.reason ?? storage.reason,
      storage: storage.storage,
    };
  }

  async start(identity) {
    const state = await this.#ledger.load();
    const record = this.#contract.record(state, identity);
    if (!record) throw new Error('environment adapter record is absent');
    const observed = await this.observe(identity);
    if (!observed.exists || !observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment is unavailable');
    if (!['running', 'blocked'].includes(observed.state)) await this.#domain.start(record.name);
    return this.observe(identity);
  }

  async stop(identity, { force = false, timeoutMs = 60_000 } = {}) {
    if (typeof force !== 'boolean') throw new TypeError('environment stop force must be boolean');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new TypeError('environment stop timeoutMs is invalid');
    const state = await this.#ledger.load();
    const record = this.#contract.record(state, identity);
    if (!record) return { identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'environment adapter record is absent', storage: null };
    let observed = await this.observe(identity);
    if (!observed.exists) return observed;
    if (!observed.owned || !observed.compatible) throw new Error(observed.reason ?? 'environment ownership evidence does not match');
    if (!['shut off', 'shutdown', 'crashed'].includes(observed.state)) {
      await this.#domain.shutdown(record.name);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        observed = await this.observe(identity);
        if (!observed.exists || ['shut off', 'shutdown', 'crashed'].includes(observed.state)) break;
      }
      if (observed.exists && !['shut off', 'shutdown', 'crashed'].includes(observed.state)) {
        if (!force) throw new Error('environment did not stop within the bounded wait');
        await this.#domain.destroy(record.name);
      }
    }
    return this.observe(identity);
  }

  async drop(identity) {
    const descriptor = this.#contract.descriptor(identity);
    const state = await this.#ledger.load();
    const record = this.#contract.record(state, identity);
    if (!record) return { identity, removed: false, absent: true };
    const observed = await this.observe(identity);
    if (observed.exists && (!observed.owned || !observed.compatible)) throw new Error(observed.reason ?? 'environment ownership evidence does not match');
    if (observed.exists && !['shut off', 'shutdown', 'crashed'].includes(observed.state)) throw new Error('environment must be stopped before removal');
    if (observed.exists) await this.#domain.remove(record);
    let diskExists = true;
    try { await lstat(record.diskPath); } catch (error) { if (error?.code === 'ENOENT') diskExists = false; else throw error; }
    if (diskExists) {
      const storage = await this.#overlay.observe(record);
      if (!storage.compatible) throw new Error(storage.reason ?? 'refusing to delete environment storage with mismatched lineage');
    }
    const localInfo = await lstat(descriptor.local).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (localInfo && (!localInfo.isDirectory() || localInfo.isSymbolicLink())) throw new Error('environment object directory shape changed');
    await rm(descriptor.local, { recursive: true, force: true });
    delete state.records[identity];
    await this.#ledger.save(state);
    return { identity, removed: true, absent: !observed.exists };
  }
}
