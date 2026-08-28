import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { normalizeBootProtection } from '../../values/boot-protection.js';
import { HyperVConstructionRequest } from './hyperv-image-construction/request-contract.js';
import { HyperVConstructionLedger } from './hyperv-image-construction/state-ledger.js';
import { HyperVConstructionMedia } from './hyperv-image-construction/media-admission.js';
import { HyperVConstructionChannel } from './hyperv-image-construction/management-channel.js';
import { HyperVConstructionObservation } from './hyperv-image-construction/observation.js';
import { HyperVInstallLiveness } from './hyperv-image-construction/install-liveness.js';
import { HyperVConsoleEvidence } from './hyperv-image-construction/console-evidence.js';

export class HyperVImageConstruction {
  #directory;
  #outputRoot;
  #request;
  #ledger;
  #media;
  #channel;
  #observation;
  #liveness;
  #console;
  #now;

  constructor({ directory, sourceRoot, outputRoot, identity, invoke, now = () => new Date() } = {}) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('construction state directory is required');
    if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) throw new TypeError('construction source root is required');
    if (typeof outputRoot !== 'string' || outputRoot.length === 0) throw new TypeError('construction output root is required');
    if (typeof now !== 'function') throw new TypeError('construction clock must be a function');
    this.#directory = path.resolve(directory);
    this.#outputRoot = path.resolve(outputRoot);
    this.#now = now;
    this.#request = new HyperVConstructionRequest({ identity, outputRoot, normalizeProtection: normalizeBootProtection });
    this.#ledger = new HyperVConstructionLedger({ directory, sourceRoot, outputRoot });
    this.#media = new HyperVConstructionMedia({ sourceRoot });
    this.#channel = new HyperVConstructionChannel({ invoke });
    this.#observation = new HyperVConstructionObservation();
    this.#liveness = new HyperVInstallLiveness();
    this.#console = new HyperVConsoleEvidence({ directory, now });
  }

  #descriptor(record) { return this.#request.descriptor(record); }

  async prepare(rawRequest) {
    const request = this.#request.normalize(rawRequest);
    await this.#ledger.ensure();
    const installerPath = await this.#media.admit(request.installer.location, request.installer);
    const seedPath = await this.#media.admit(request.seed.location, request.seed);
    const state = await this.#ledger.load();
    let record = state.records[request.identity];
    if (!record) {
      const identity = this.#request.create(request);
      const diskPath = path.join(this.#outputRoot, identity.diskName);
      try { await lstat(diskPath); throw new Error('construction output already exists without durable intent'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      record = {
        ...identity,
        installer: { bytes: request.installer.bytes, sha256: request.installer.sha256, location: installerPath },
        seed: { bytes: request.seed.bytes, sha256: request.seed.sha256, location: seedPath },
        memoryBytes: request.memoryBytes,
        processorCount: request.processorCount,
        diskBytes: request.diskBytes,
        network: request.network,
        bootProtection: request.bootProtection,
        phase: 'planned',
        providerIdentity: null,
      };
      state.records[request.identity] = record;
      await this.#ledger.save(state);
    } else if (!this.#request.same(record, request)) {
      throw new Error('construction request changed after durable intent');
    }

    if (record.phase !== 'planned' && record.phase !== 'prepared') return this.status(request.identity);
    const result = await this.#channel.prepare({
      ...this.#descriptor(record),
      installerPath,
      seedPath,
      memoryBytes: record.memoryBytes,
      processorCount: record.processorCount,
      diskBytes: record.diskBytes,
      networkReference: record.network.reference,
      networkProof: record.network.proof,
      networkControl: record.network.control,
      ...this.#request.bootSettings(record.bootProtection ?? null),
    });
    if (result.ready !== true || typeof result.providerIdentity !== 'string') throw new Error('construction preparation did not become ready');
    record.providerIdentity = result.providerIdentity;
    record.phase = 'prepared';
    await this.#ledger.save(state);
    return this.status(request.identity);
  }

  async status(rawIdentity) {
    const identity = this.#request.subject(rawIdentity);
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record) return this.#observation.status(identity, null, null);
    const observed = await this.#channel.observe({
      ...this.#descriptor(record),
      ...this.#request.bootSettings(record.bootProtection ?? null),
    });
    return this.#observation.status(identity, record, observed);
  }

  async observeInstall(rawIdentity) {
    const identity = this.#request.subject(rawIdentity);
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record || record.phase !== 'installing' || !record.providerIdentity) throw new Error('construction is not awaiting installation completion');
    const observed = await this.status(identity);
    const liveness = this.#liveness.checkpoint(record.installLiveness ?? null, observed, this.#now());
    record.installLiveness = liveness;
    await this.#ledger.save(state);
    return { ...observed, liveness: Object.freeze({ ...liveness }) };
  }

  async captureInstallConsole(rawIdentity) {
    const identity = this.#request.subject(rawIdentity);
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record || record.phase !== 'installing' || !record.providerIdentity) throw new Error('construction is not awaiting installation completion');
    const observed = await this.status(identity);
    if (!observed.exists || !observed.owned || observed.state !== 'running' || observed.mediaCount < 1) {
      throw new Error('construction console is unavailable outside the running installer frontier');
    }
    return this.#console.publish(identity, await this.#channel.console(this.#descriptor(record)));
  }

  async locate(rawIdentity) {
    const identity = this.#request.subject(rawIdentity);
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record || record.phase !== 'qualifying' || !record.providerIdentity) throw new Error('construction is not available for qualification');
    const observed = await this.status(identity);
    if (!observed.exists || !observed.owned || observed.state !== 'running' || !observed.diskAttached || observed.mediaCount !== 0) {
      throw new Error('construction is not running from its installed disk for qualification');
    }
    return Object.freeze({ reference: record.name, proof: record.marker });
  }

  async connectionAddress(rawIdentity) {
    const identity = this.#request.subject(rawIdentity);
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record || record.phase !== 'qualifying' || !record.providerIdentity) throw new Error('construction is not available for access');
    const observed = await this.#channel.address({
      ...this.#descriptor(record),
      networkControl: record.network.control,
      networkReference: record.network.reference,
    });
    return this.#observation.address(observed);
  }

  async startInstall(rawIdentity) {
    const identity = this.#request.subject(rawIdentity);
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record || record.phase !== 'prepared' || !record.providerIdentity) throw new Error('construction is not prepared for installation');
    await this.#media.admit(record.installer.location, record.installer);
    await this.#media.admit(record.seed.location, record.seed);
    const result = await this.#channel.startInstall(this.#descriptor(record));
    if (result.started !== true) throw new Error('construction installer did not start');
    record.phase = 'installing';
    await this.#ledger.save(state);
    return this.observeInstall(identity);
  }

  async bootInstalled(rawIdentity) {
    const identity = this.#request.subject(rawIdentity);
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record || record.phase !== 'installing' || !record.providerIdentity) throw new Error('construction is not awaiting installed boot');
    const observed = await this.status(identity);
    if (!observed.exists || !observed.diskPresent || !observed.diskAttached) throw new Error('installer has not completed with the exact retained disk');
    if (observed.state === 'running' && observed.mediaCount === 0) {
      record.phase = 'qualifying';
      await this.#ledger.save(state);
      return this.status(identity);
    }
    if (observed.state !== 'off') throw new Error('installer has not completed with a retained disk');
    if (![0, 2].includes(observed.mediaCount)) throw new Error('construction media attachment state is ambiguous');
    const result = await this.#channel.bootInstalled(this.#descriptor(record));
    if (result.started !== true) throw new Error('installed construction did not start');
    record.phase = 'qualifying';
    await this.#ledger.save(state);
    return this.status(identity);
  }

  async stop(rawIdentity, { force = false } = {}) {
    const identity = this.#request.subject(rawIdentity);
    if (typeof force !== 'boolean') throw new TypeError('construction stop force is invalid');
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record || !record.providerIdentity) throw new Error('construction is not materialized');
    const result = await this.#channel.stop({ ...this.#descriptor(record), force });
    if (result.stopped !== true && result.absent !== true) throw new Error('construction stop did not reconcile');
    return this.status(identity);
  }

  async markQualified(rawIdentity, evidence) {
    const identity = this.#request.subject(rawIdentity);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new TypeError('construction qualification evidence is invalid');
    const serialized = JSON.stringify(evidence);
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) throw new Error('construction qualification evidence is too large');
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record || record.phase !== 'qualifying') throw new Error('construction is not in qualification');
    const observed = await this.status(identity);
    if (!observed.exists || observed.state !== 'off') throw new Error('qualified construction must be shut down before acceptance');
    record.qualification = structuredClone(evidence);
    record.phase = 'qualified';
    await this.#ledger.save(state);
    return { identity, phase: record.phase, qualification: structuredClone(record.qualification) };
  }

  async retain(rawIdentity) {
    const identity = this.#request.subject(rawIdentity);
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record || !['qualified', 'retained'].includes(record.phase) || !record.providerIdentity) throw new Error('construction is not qualified for retention');
    const result = await this.#channel.retain(this.#descriptor(record));
    if (result.retained !== true) throw new Error('construction disk was not retained');
    record.phase = 'retained';
    record.disk = { virtualBytes: Number(result.virtualBytes), allocatedBytes: Number(result.allocatedBytes), identity: String(result.diskIdentity ?? '') };
    await this.#ledger.save(state);
    return {
      identity,
      phase: record.phase,
      location: path.join(this.#outputRoot, record.diskName),
      qualification: structuredClone(record.qualification),
      disk: structuredClone(record.disk),
    };
  }

  async discard(rawIdentity) {
    const identity = this.#request.subject(rawIdentity);
    const state = await this.#ledger.load();
    const record = state.records[identity];
    if (!record) return { identity, discarded: false, absent: true };
    const observed = await this.status(identity);
    if (observed.exists && observed.state !== 'off') throw new Error('construction must be stopped before discard');
    const result = await this.#channel.discard(this.#descriptor(record));
    if (result.discarded !== true) throw new Error('construction discard did not reconcile');
    delete state.records[identity];
    await this.#ledger.save(state);
    await rm(path.join(this.#outputRoot, record.key + '-vm'), { recursive: true, force: true }).catch(() => {});
    return { identity, discarded: true, absent: false };
  }
}

export function createHyperVImageConstruction(options) {
  return new HyperVImageConstruction(options);
}
