import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeBootProtection } from '../../values/boot-protection.js';
import { HyperVEnvironmentContract } from './hyperv-persistent-environment/environment-contract.js';
import { HyperVEnvironmentLedger } from './hyperv-persistent-environment/state-ledger.js';
import { HyperVEnvironmentChannel } from './hyperv-persistent-environment/management-channel.js';
import { HyperVStorageLineage } from './hyperv-persistent-environment/storage-lineage.js';

export class HyperVPersistentEnvironment {
  #directory;
  #contract;
  #ledger;
  #channel;
  #storage;

  constructor({ directory, sourceRoot, identity, invoke }) {
    this.#directory = path.resolve(directory);
    this.#contract = new HyperVEnvironmentContract({
      directory,
      sourceRoot,
      identity,
      normalizeProtection: normalizeBootProtection,
    });
    this.#ledger = new HyperVEnvironmentLedger({ directory });
    this.#channel = new HyperVEnvironmentChannel({ invoke });
    this.#storage = new HyperVStorageLineage({
      inspect: (record) => this.#channel.inspectStorage(record),
    });
  }

  async inspect() { return { identity: this.#contract.binding() }; }

  async provision(raw) {
    const input = this.#contract.request(raw);
    const identity = input.identity;
    const descriptor = this.#contract.descriptor(identity);
    const admitted = await this.#contract.source(input.source);
    const settings = this.#contract.settings(input.settings);
    const state = await this.#ledger.load();
    const diskPath = path.join(descriptor.local, 'state.' + admitted.format);
    const record = {
      identity,
      sourceIdentity: admitted.identity,
      sourceRevision: admitted.revision,
      sourceDigest: admitted.digest,
      parentPath: admitted.location,
      parentFileIdentity: admitted.fileIdentity,
      diskPath,
      diskFileIdentity: null,
      providerIdentity: null,
      diskFormat: admitted.format,
      name: descriptor.name,
      marker: descriptor.marker,
      configPath: descriptor.configPath,
      settings: structuredClone(settings),
    };
    const existing = this.#contract.record(state, identity);
    if (existing) {
      const comparableExisting = { ...existing, diskFileIdentity: null, providerIdentity: null };
      if (JSON.stringify(comparableExisting) !== JSON.stringify(record)) throw new Error('environment adapter record conflicts with the requested lineage');
    } else {
      state.records[identity] = record;
      await this.#ledger.save(state);
    }

    await mkdir(descriptor.local, { recursive: true, mode: 0o700 });
    const localInfo = await lstat(descriptor.local);
    if (!localInfo.isDirectory() || localInfo.isSymbolicLink()) throw new Error('environment object directory must be a real directory');
    const outcome = await this.#channel.provision({
      ...state.records[identity],
      memoryBytes: settings.memoryBytes,
      processorCount: settings.processorCount,
      firmware: settings.firmware,
      ...this.#contract.bootSettings(settings),
    });
    const providerIdentity = this.#contract.providerIdentity(outcome?.providerIdentity);
    if (state.records[identity].providerIdentity && state.records[identity].providerIdentity !== providerIdentity) throw new Error('environment provider identity changed during provisioning');
    if (!state.records[identity].providerIdentity) {
      state.records[identity].providerIdentity = providerIdentity;
      await this.#ledger.save(state);
    }
    if (!state.records[identity].diskFileIdentity) {
      state.records[identity].diskFileIdentity = await this.#storage.capture(diskPath);
      await this.#ledger.save(state);
    }
    return this.observe(identity);
  }

  async observe(identity) {
    this.#contract.descriptor(identity);
    const state = await this.#ledger.load();
    const record = this.#contract.record(state, identity);
    if (!record) return { identity, exists: false, owned: false, compatible: false, state: 'absent', reason: 'environment adapter record is absent', storage: null };
    const changed = await this.#storage.changed(record);
    if (changed) return { identity, exists: true, owned: true, compatible: false, state: 'unknown', reason: changed, storage: null };
    return this.#channel.observe(identity, {
      ...record,
      ...this.#contract.bootSettings(this.#contract.settings(record.settings)),
    }, record.sourceIdentity);
  }

  async start(identity) {
    const state = await this.#ledger.load();
    const record = this.#contract.record(state, identity);
    if (!record) throw new Error('environment adapter record is absent');
    await this.#channel.start(record);
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
    if (observed.state !== 'off') {
      await this.#channel.stop(record, false);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        observed = await this.observe(identity);
        if (!observed.exists || observed.state === 'off') break;
      }
      if (observed.exists && observed.state !== 'off') {
        if (!force) throw new Error('environment did not stop within the bounded wait');
        await this.#channel.stop(record, true);
        observed = await this.observe(identity);
        if (observed.exists && observed.state !== 'off') throw new Error('environment did not stop after forced termination');
      }
    }
    return observed;
  }

  async drop(identity) {
    const descriptor = this.#contract.descriptor(identity);
    const state = await this.#ledger.load();
    const record = this.#contract.record(state, identity);
    if (!record) return { identity, removed: false, absent: true };
    const diskInfo = await this.#storage.existing(record.diskPath);
    if (diskInfo) {
      const storage = await this.#storage.observe(record);
      if (!storage.compatible) throw new Error(storage.reason ?? 'refusing to delete environment storage with mismatched lineage');
    }
    const observed = await this.observe(identity);
    if (observed.exists && (!observed.owned || !observed.compatible)) throw new Error(observed.reason ?? 'environment ownership evidence does not match');
    if (observed.exists && observed.state !== 'off') throw new Error('environment must be stopped before removal');
    const result = await this.#channel.remove(record);
    if (diskInfo) await this.#storage.assertContainedFile(this.#directory, record.diskPath, diskInfo);
    const localInfo = await lstat(descriptor.local).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (localInfo && (!localInfo.isDirectory() || localInfo.isSymbolicLink())) throw new Error('environment object directory shape changed');
    await rm(descriptor.local, { recursive: true, force: true });
    delete state.records[identity];
    await this.#ledger.save(state);
    return { identity, removed: result.removed === true || diskInfo != null, absent: result.absent === true && diskInfo == null };
  }
}
