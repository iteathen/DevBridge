import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROTOCOL = 'devbridge/exclusive-physical-devices-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const CLAIM_ID = /^claim-[a-f0-9]{32}$/u;
const MAX_REASON_BYTES = 2048;
const MAX_CAPABILITIES = 32;
const PUBLIC_STATES = new Set(['AVAILABLE', 'CLAIMING', 'OWNED', 'RELEASING', 'CLAIM_FAILED', 'RELEASE_FAILED', 'QUARANTINED', 'RECOVERY_REQUIRED']);
const PROVIDER_OBSERVATION_KEYS = new Set(['subject', 'deviceGeneration', 'state', 'rootSafe', 'owner', 'assignmentGeneration', 'reason']);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function requireId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function requireGeneration(value, name) {
  if (typeof value !== 'string' || !GENERATION.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeReason(value) {
  if (value == null) return null;
  return Buffer.from(String(value), 'utf8').subarray(0, MAX_REASON_BYTES).toString('utf8');
}

function normalizeCapabilities(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_CAPABILITIES) throw new TypeError('device capabilities must be a bounded array');
  return [...new Set(raw.map((item) => requireId(item, 'device capability')))];
}

function normalizeInventory(raw, expectedSubject) {
  const value = requireObject(raw, 'device inventory');
  onlyKeys(value, new Set(['subject', 'generation', 'eligible', 'critical', 'capabilities', 'reason']), 'device inventory');
  if (value.subject !== expectedSubject) throw new Error('device inventory subject changed');
  return {
    subject: expectedSubject,
    generation: requireGeneration(value.generation, 'device generation'),
    eligible: value.eligible === true,
    critical: value.critical === true,
    capabilities: normalizeCapabilities(value.capabilities ?? []),
    reason: normalizeReason(value.reason),
  };
}

function normalizeEnvironment(raw) {
  const value = requireObject(raw, 'environment');
  onlyKeys(value, new Set(['identity', 'generation']), 'environment');
  return {
    identity: requireId(value.identity, 'environment identity'),
    generation: requireGeneration(value.generation, 'environment generation'),
  };
}

function sameEnvironment(left, right) {
  return left?.identity === right?.identity && left?.generation === right?.generation;
}

function normalizeAdmission(raw, expected) {
  const value = requireObject(raw, 'environment admission');
  onlyKeys(value, new Set(['identity', 'generation', 'admitted', 'reason']), 'environment admission');
  const observed = { identity: value.identity, generation: value.generation };
  if (!sameEnvironment(observed, expected)) throw new Error('environment admission identity changed');
  return { ...expected, admitted: value.admitted === true, reason: normalizeReason(value.reason) };
}

function normalizePreparation(raw, expected) {
  const value = requireObject(raw, 'guest device preparation');
  onlyKeys(value, new Set(['identity', 'generation', 'ready', 'preparationGeneration', 'reason']), 'guest device preparation');
  const observed = { identity: value.identity, generation: value.generation };
  if (!sameEnvironment(observed, expected)) throw new Error('guest preparation environment identity changed');
  return {
    ...expected,
    ready: value.ready === true,
    preparationGeneration: requireGeneration(value.preparationGeneration, 'preparation generation'),
    reason: normalizeReason(value.reason),
  };
}

function normalizeOwner(raw) {
  if (raw == null) return null;
  return normalizeEnvironment(raw);
}

function normalizeProviderObservation(raw, expectedSubject) {
  const value = requireObject(raw, 'device assignment observation');
  onlyKeys(value, PROVIDER_OBSERVATION_KEYS, 'device assignment observation');
  if (value.subject !== expectedSubject) throw new Error('device assignment observation subject changed');
  const state = value.state;
  if (state !== 'available' && state !== 'owned' && state !== 'unknown') throw new TypeError('device assignment observation state is invalid');
  const owner = normalizeOwner(value.owner);
  const rootSafe = value.rootSafe === true;
  if (state === 'available' && (!rootSafe || owner != null)) throw new Error('available device observation must be root-safe and ownerless');
  if (state === 'owned' && (rootSafe || owner == null)) throw new Error('owned device observation must name exactly one environment and not be root-safe');
  return {
    subject: expectedSubject,
    deviceGeneration: requireGeneration(value.deviceGeneration, 'observed device generation'),
    state,
    rootSafe,
    owner,
    assignmentGeneration: value.assignmentGeneration == null ? null : requireGeneration(value.assignmentGeneration, 'assignment generation'),
    reason: normalizeReason(value.reason),
  };
}

function normalizeQualification(raw, expectedEnvironment) {
  const value = requireObject(raw, 'device qualification');
  onlyKeys(value, new Set(['identity', 'generation', 'qualified', 'qualificationGeneration', 'reason']), 'device qualification');
  const observed = { identity: value.identity, generation: value.generation };
  if (!sameEnvironment(observed, expectedEnvironment)) throw new Error('device qualification environment identity changed');
  return {
    ...expectedEnvironment,
    qualified: value.qualified === true,
    qualificationGeneration: requireGeneration(value.qualificationGeneration, 'qualification generation'),
    reason: normalizeReason(value.reason),
  };
}

function normalizeQuiescence(raw, expectedEnvironment) {
  const value = requireObject(raw, 'guest device quiescence');
  onlyKeys(value, new Set(['identity', 'generation', 'quiesced', 'environmentStopped', 'reason']), 'guest device quiescence');
  const observed = { identity: value.identity, generation: value.generation };
  if (!sameEnvironment(observed, expectedEnvironment)) throw new Error('guest quiescence environment identity changed');
  return {
    ...expectedEnvironment,
    quiesced: value.quiesced === true,
    environmentStopped: value.environmentStopped === true,
    reason: normalizeReason(value.reason),
  };
}

function normalizeRebind(raw, expectedEnvironment) {
  const value = requireObject(raw, 'guest device rebind');
  onlyKeys(value, new Set(['identity', 'generation', 'ready', 'environmentRestarted', 'reason']), 'guest device rebind');
  const observed = { identity: value.identity, generation: value.generation };
  if (!sameEnvironment(observed, expectedEnvironment)) throw new Error('guest rebind environment identity changed');
  return {
    ...expectedEnvironment,
    ready: value.ready === true,
    environmentRestarted: value.environmentRestarted === true,
    reason: normalizeReason(value.reason),
  };
}

function assertContract(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

function emptyCatalog() {
  return { protocol: PROTOCOL, revision: 0, devices: {}, operations: {} };
}

function claimIdentity(subject, deviceGeneration, environment, operationId) {
  return `claim-${createHash('sha256').update(`${subject}\0${deviceGeneration}\0${environment.identity}\0${environment.generation}\0${operationId}`, 'utf8').digest('hex').slice(0, 32)}`;
}

function publicClaim(entry) {
  if (!entry?.claim) return null;
  return structuredClone(entry.claim);
}

function publicStatus(entry, inventory, observation) {
  const state = entry?.state ?? (observation.state === 'available' && observation.rootSafe ? 'AVAILABLE' : 'RECOVERY_REQUIRED');
  if (!PUBLIC_STATES.has(state)) throw new Error('stored device state is invalid');
  return {
    subject: inventory.subject,
    deviceGeneration: inventory.generation,
    state,
    capabilities: structuredClone(inventory.capabilities),
    claim: publicClaim(entry),
    provider: {
      state: observation.state,
      rootSafe: observation.rootSafe,
      owner: observation.owner ? structuredClone(observation.owner) : null,
      assignmentGeneration: observation.assignmentGeneration,
      reason: observation.reason,
    },
    reason: entry?.reason ?? null,
  };
}

function recordError(operation, error) {
  operation.lastError = normalizeReason(error?.message ?? error);
  operation.lastErrorAt = new Date().toISOString();
}

export class ExclusivePhysicalDevices {
  #directory;
  #catalogFile;
  #guardFile;
  #inventory;
  #environments;
  #assignment;
  #preparation;
  #guestLifecycle;
  #qualification;
  #tail = Promise.resolve();

  constructor({ directory, inventory, environments, assignment, preparation, guestLifecycle, qualification }) {
    if (typeof directory !== 'string' || directory.length === 0) throw new TypeError('device authority directory is required');
    this.#directory = path.resolve(directory);
    this.#catalogFile = path.join(this.#directory, 'catalog.json');
    this.#guardFile = path.join(this.#directory, 'lifecycle.lock');
    this.#inventory = assertContract(inventory, ['resolve'], 'device inventory');
    this.#environments = assertContract(environments, ['observe'], 'environment admission');
    this.#assignment = assertContract(assignment, ['observe', 'claim', 'release'], 'device assignment');
    this.#preparation = assertContract(preparation, ['observe'], 'guest device preparation');
    this.#guestLifecycle = assertContract(guestLifecycle, ['quiesce', 'rebind'], 'guest device lifecycle');
    this.#qualification = assertContract(qualification, ['qualify'], 'device qualification');
  }

  async #ensureDirectory() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('device authority directory must be a real directory');
  }

  async #acquire() {
    await this.#ensureDirectory();
    const token = randomUUID();
    let handle;
    try {
      handle = await open(this.#guardFile, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('physical device lifecycle mutation is already active; reconcile ownership before removing lifecycle.lock');
      throw error;
    }
    try {
      await handle.writeFile(`${token}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(this.#guardFile, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    return async () => {
      const observed = (await readFile(this.#guardFile, 'utf8')).trim();
      if (observed !== token) throw new Error('physical device lifecycle guard ownership changed');
      await rm(this.#guardFile);
    };
  }

  #serial(work) {
    const guarded = async () => {
      const release = await this.#acquire();
      try { return await work(); }
      finally { await release(); }
    };
    const next = this.#tail.then(guarded, guarded);
    this.#tail = next.catch(() => {});
    return next;
  }

  async #load() {
    await this.#ensureDirectory();
    try {
      const info = await lstat(this.#catalogFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('device authority catalog must be a real file');
      const catalog = JSON.parse(await readFile(this.#catalogFile, 'utf8'));
      if (!catalog || catalog.protocol !== PROTOCOL || !catalog.devices || !catalog.operations) throw new Error('device authority catalog is invalid');
      return catalog;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyCatalog();
      throw error;
    }
  }

  async #save(catalog) {
    catalog.revision = Number(catalog.revision ?? 0) + 1;
    const temporary = path.join(this.#directory, `.catalog-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(catalog)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, this.#catalogFile);
  }

  async #inventoryFor(subject) {
    const id = requireId(subject, 'physical device subject');
    return normalizeInventory(await this.#inventory.resolve(id), id);
  }

  async #providerObservation(inventory) {
    const observed = normalizeProviderObservation(await this.#assignment.observe(inventory.subject), inventory.subject);
    if (observed.deviceGeneration !== inventory.generation) throw new Error('provider observation device generation changed');
    return observed;
  }

  async #admitted(environment) {
    const admitted = normalizeAdmission(await this.#environments.observe(environment), environment);
    if (!admitted.admitted) throw new Error(admitted.reason ?? 'target environment is not admitted');
    return admitted;
  }

  async #prepared(environment) {
    const prepared = normalizePreparation(await this.#preparation.observe(environment), environment);
    if (!prepared.ready) throw new Error(prepared.reason ?? 'target environment is not prepared for the physical device');
    return prepared;
  }

  #ensureEligible(inventory) {
    if (inventory.critical) throw new Error(inventory.reason ?? 'physical device is host-critical and cannot be claimed');
    if (!inventory.eligible) throw new Error(inventory.reason ?? 'physical device is not locally approved for assignment');
  }

  #entryFor(catalog, inventory, observation) {
    let entry = catalog.devices[inventory.subject] ?? null;
    if (!entry) {
      if (observation.state !== 'available' || !observation.rootSafe) return null;
      entry = {
        subject: inventory.subject,
        deviceGeneration: inventory.generation,
        state: 'AVAILABLE',
        claim: null,
        reason: null,
        updatedAt: new Date().toISOString(),
      };
      catalog.devices[inventory.subject] = entry;
    }
    return entry;
  }

  #requireGeneration(entry, inventory) {
    if (entry.deviceGeneration !== inventory.generation) throw new Error('physical device generation changed; reconciliation is required');
  }

  #pending(catalog, subject) {
    return Object.values(catalog.operations)
      .filter((operation) => operation.subject === subject && operation.state !== 'reconciled')
      .sort((left, right) => String(left.plannedAt).localeCompare(String(right.plannedAt)));
  }

  #quarantine(entry, reason, state = 'QUARANTINED') {
    entry.state = state;
    entry.reason = normalizeReason(reason) ?? 'physical device ownership is ambiguous';
    entry.updatedAt = new Date().toISOString();
  }

  async observe(subject) {
    return this.#serial(async () => {
      const inventory = await this.#inventoryFor(subject);
      const observation = await this.#providerObservation(inventory);
      const catalog = await this.#load();
      const entry = catalog.devices[inventory.subject] ?? null;
      return publicStatus(entry, inventory, observation);
    });
  }

  async claim(subject, rawEnvironment) {
    return this.#serial(async () => {
      const environment = normalizeEnvironment(rawEnvironment);
      const inventory = await this.#inventoryFor(subject);
      this.#ensureEligible(inventory);
      await this.#admitted(environment);
      const preparation = await this.#prepared(environment);
      const catalog = await this.#load();
      if (this.#pending(catalog, inventory.subject).length > 0) throw new Error('physical device has an unreconciled lifecycle operation');
      let observation = await this.#providerObservation(inventory);
      const entry = this.#entryFor(catalog, inventory, observation);
      if (!entry) throw new Error('physical device is not proven root-safe; reconciliation is required');
      this.#requireGeneration(entry, inventory);
      if (entry.state !== 'AVAILABLE') throw new Error(`physical device is not available: ${entry.state}`);
      if (observation.state !== 'available' || !observation.rootSafe) throw new Error('physical device is not provider-observed as root-safe available');

      const operationId = `op-${randomUUID()}`;
      const claimId = claimIdentity(inventory.subject, inventory.generation, environment, operationId);
      const operation = {
        id: operationId,
        kind: 'claim',
        state: 'planned',
        subject: inventory.subject,
        deviceGeneration: inventory.generation,
        environment,
        preparationGeneration: preparation.preparationGeneration,
        claimId,
        plannedAt: new Date().toISOString(),
      };
      catalog.operations[operationId] = operation;
      entry.state = 'CLAIMING';
      entry.reason = null;
      entry.updatedAt = operation.plannedAt;
      await this.#save(catalog);

      try {
        return await this.#completeClaim(catalog, entry, operation, inventory);
      } catch (error) {
        recordError(operation, error);
        if (operation.state === 'planned') entry.state = 'CLAIM_FAILED';
        else this.#quarantine(entry, error?.message, 'RECOVERY_REQUIRED');
        entry.reason = normalizeReason(error?.message);
        await this.#save(catalog);
        throw error;
      }
    });
  }

  async #completeClaim(catalog, entry, operation, inventory) {
    await this.#admitted(operation.environment);
    const preparation = await this.#prepared(operation.environment);
    if (preparation.preparationGeneration !== operation.preparationGeneration) {
      throw new Error('guest preparation generation changed before physical device claim reconciliation');
    }

    let observation = await this.#providerObservation(inventory);
    if (observation.state === 'available' && observation.rootSafe) {
      operation.state = 'attempted';
      operation.attemptedAt = new Date().toISOString();
      await this.#save(catalog);
      await this.#assignment.claim({
        subject: inventory.subject,
        deviceGeneration: inventory.generation,
        environment: structuredClone(operation.environment),
      });
      observation = await this.#providerObservation(inventory);
    }
    if (observation.state !== 'owned' || !sameEnvironment(observation.owner, operation.environment)) {
      throw new Error(observation.reason ?? 'physical device claim did not establish the intended exclusive owner');
    }

    if (operation.assignmentGeneration != null && observation.assignmentGeneration !== operation.assignmentGeneration) {
      throw new Error('physical device assignment generation changed during claim reconciliation');
    }
    operation.state = 'observed';
    operation.observedAt = new Date().toISOString();
    operation.assignmentGeneration = observation.assignmentGeneration;
    await this.#save(catalog);

    const rebound = normalizeRebind(await this.#guestLifecycle.rebind({
      subject: inventory.subject,
      deviceGeneration: inventory.generation,
      environment: structuredClone(operation.environment),
    }), operation.environment);
    if (!rebound.ready) throw new Error(rebound.reason ?? 'guest did not rebind the claimed physical device');

    const qualification = normalizeQualification(await this.#qualification.qualify({
      subject: inventory.subject,
      deviceGeneration: inventory.generation,
      environment: structuredClone(operation.environment),
      assignmentGeneration: observation.assignmentGeneration,
    }), operation.environment);
    if (!qualification.qualified) throw new Error(qualification.reason ?? 'claimed physical device did not pass native capability qualification');

    observation = await this.#providerObservation(inventory);
    if (observation.state !== 'owned' || !sameEnvironment(observation.owner, operation.environment)) {
      throw new Error('physical device ownership changed during qualification');
    }
    if (operation.assignmentGeneration != null && observation.assignmentGeneration !== operation.assignmentGeneration) {
      throw new Error('physical device assignment generation changed during qualification');
    }

    entry.state = 'OWNED';
    entry.reason = null;
    entry.claim = {
      id: operation.claimId,
      subject: inventory.subject,
      deviceGeneration: inventory.generation,
      environment: structuredClone(operation.environment),
      preparationGeneration: operation.preparationGeneration,
      assignmentGeneration: observation.assignmentGeneration,
      qualificationGeneration: qualification.qualificationGeneration,
      claimedAt: operation.plannedAt,
    };
    entry.updatedAt = new Date().toISOString();
    operation.state = 'reconciled';
    operation.reconciledAt = entry.updatedAt;
    await this.#save(catalog);
    return publicStatus(entry, inventory, observation);
  }

  async release(rawClaim) {
    return this.#serial(async () => {
      const claim = requireObject(rawClaim, 'physical device claim');
      onlyKeys(claim, new Set(['id', 'subject', 'deviceGeneration', 'environment', 'preparationGeneration', 'assignmentGeneration', 'qualificationGeneration', 'claimedAt']), 'physical device claim');
      if (typeof claim.id !== 'string' || !CLAIM_ID.test(claim.id)) throw new TypeError('physical device claim id is invalid');
      const environment = normalizeEnvironment(claim.environment);
      const inventory = await this.#inventoryFor(requireId(claim.subject, 'physical device claim subject'));
      const catalog = await this.#load();
      if (this.#pending(catalog, inventory.subject).length > 0) throw new Error('physical device has an unreconciled lifecycle operation');
      const entry = catalog.devices[inventory.subject];
      if (!entry) throw new Error('physical device is not registered');
      this.#requireGeneration(entry, inventory);
      if (entry.state !== 'OWNED' || entry.claim?.id !== claim.id || !sameEnvironment(entry.claim?.environment, environment)) {
        throw new Error('physical device claim is stale or no longer authoritative');
      }
      if (claim.deviceGeneration !== inventory.generation) throw new Error('physical device claim generation is stale');

      const operationId = `op-${randomUUID()}`;
      const operation = {
        id: operationId,
        kind: 'release',
        state: 'planned',
        subject: inventory.subject,
        deviceGeneration: inventory.generation,
        environment,
        claimId: claim.id,
        assignmentGeneration: entry.claim.assignmentGeneration,
        plannedAt: new Date().toISOString(),
      };
      catalog.operations[operationId] = operation;
      entry.state = 'RELEASING';
      entry.reason = null;
      entry.updatedAt = operation.plannedAt;
      await this.#save(catalog);

      try {
        return await this.#completeRelease(catalog, entry, operation, inventory);
      } catch (error) {
        recordError(operation, error);
        if (operation.state === 'planned') entry.state = 'RELEASE_FAILED';
        else this.#quarantine(entry, error?.message, 'RECOVERY_REQUIRED');
        entry.reason = normalizeReason(error?.message);
        await this.#save(catalog);
        throw error;
      }
    });
  }

  async #completeRelease(catalog, entry, operation, inventory) {
    let observation = await this.#providerObservation(inventory);
    if (observation.state === 'owned') {
      if (!sameEnvironment(observation.owner, operation.environment)) throw new Error('physical device is owned by an unexpected environment');
      if (operation.assignmentGeneration != null && observation.assignmentGeneration !== operation.assignmentGeneration) {
        throw new Error('physical device assignment generation no longer matches the claim');
      }
      const quiesced = normalizeQuiescence(await this.#guestLifecycle.quiesce({
        subject: inventory.subject,
        deviceGeneration: inventory.generation,
        environment: structuredClone(operation.environment),
      }), operation.environment);
      if (!quiesced.quiesced) throw new Error(quiesced.reason ?? 'guest device work did not quiesce for release');

      operation.state = 'attempted';
      operation.attemptedAt = new Date().toISOString();
      await this.#save(catalog);
      await this.#assignment.release({
        subject: inventory.subject,
        deviceGeneration: inventory.generation,
        environment: structuredClone(operation.environment),
        assignmentGeneration: operation.assignmentGeneration,
      });
      observation = await this.#providerObservation(inventory);
    }
    if (observation.state !== 'available' || !observation.rootSafe || observation.owner != null) {
      throw new Error(observation.reason ?? 'physical device release did not prove root-safe availability');
    }

    operation.state = 'observed';
    operation.observedAt = new Date().toISOString();
    await this.#save(catalog);

    const preparation = normalizePreparation(await this.#preparation.observe(operation.environment), operation.environment);
    entry.state = 'AVAILABLE';
    entry.claim = null;
    entry.reason = preparation.ready ? null : (preparation.reason ?? 'former owner device preparation is no longer ready');
    entry.updatedAt = new Date().toISOString();
    operation.preparationStillReady = preparation.ready;
    operation.state = 'reconciled';
    operation.reconciledAt = entry.updatedAt;
    await this.#save(catalog);

    return {
      ...publicStatus(entry, inventory, observation),
      releasedClaimId: operation.claimId,
      formerOwnerPreparationReady: preparation.ready,
      formerOwnerPreparationGeneration: preparation.preparationGeneration,
    };
  }

  async reconcile(subject) {
    return this.#serial(async () => {
      const inventory = await this.#inventoryFor(subject);
      const catalog = await this.#load();
      let observation;
      try {
        observation = await this.#providerObservation(inventory);
      } catch (error) {
        const existing = catalog.devices[inventory.subject];
        if (existing) {
          this.#quarantine(existing, error?.message, 'RECOVERY_REQUIRED');
          await this.#save(catalog);
        }
        throw error;
      }
      let entry = this.#entryFor(catalog, inventory, observation);
      if (!entry) {
        entry = {
          subject: inventory.subject,
          deviceGeneration: inventory.generation,
          state: 'RECOVERY_REQUIRED',
          claim: null,
          reason: observation.reason ?? 'provider ownership is not locally explainable',
          updatedAt: new Date().toISOString(),
        };
        catalog.devices[inventory.subject] = entry;
        await this.#save(catalog);
        return publicStatus(entry, inventory, observation);
      }
      if (entry.deviceGeneration !== inventory.generation) {
        this.#quarantine(entry, 'physical device generation changed while durable ownership state existed', 'RECOVERY_REQUIRED');
        await this.#save(catalog);
        return publicStatus(entry, inventory, observation);
      }

      const pending = this.#pending(catalog, inventory.subject);
      if (pending.length > 1) {
        this.#quarantine(entry, 'multiple unreconciled device lifecycle operations exist');
        await this.#save(catalog);
        return publicStatus(entry, inventory, observation);
      }
      if (pending.length === 1) {
        const operation = pending[0];
        try {
          if (operation.kind === 'claim') return await this.#completeClaim(catalog, entry, operation, inventory);
          if (operation.kind === 'release') return await this.#completeRelease(catalog, entry, operation, inventory);
          throw new Error('unknown device lifecycle operation requires recovery');
        } catch (error) {
          recordError(operation, error);
          this.#quarantine(entry, error?.message, 'RECOVERY_REQUIRED');
          await this.#save(catalog);
          return publicStatus(entry, inventory, await this.#providerObservation(inventory));
        }
      }

      if (observation.state === 'available' && observation.rootSafe) {
        entry.state = 'AVAILABLE';
        entry.claim = null;
        entry.reason = null;
        entry.updatedAt = new Date().toISOString();
        await this.#save(catalog);
        return publicStatus(entry, inventory, observation);
      }
      if (observation.state === 'owned' && entry.claim && sameEnvironment(entry.claim.environment, observation.owner)) {
        if (entry.claim.assignmentGeneration == null || entry.claim.assignmentGeneration === observation.assignmentGeneration) {
          if (entry.state === 'OWNED') return publicStatus(entry, inventory, observation);
          try {
            await this.#admitted(entry.claim.environment);
            const preparation = await this.#prepared(entry.claim.environment);
            if (preparation.preparationGeneration !== entry.claim.preparationGeneration) throw new Error('guest preparation generation changed');
            const rebound = normalizeRebind(await this.#guestLifecycle.rebind({
              subject: inventory.subject,
              deviceGeneration: inventory.generation,
              environment: structuredClone(entry.claim.environment),
            }), entry.claim.environment);
            if (!rebound.ready) throw new Error(rebound.reason ?? 'guest did not rebind the physical device during reconciliation');
            const qualification = normalizeQualification(await this.#qualification.qualify({
              subject: inventory.subject,
              deviceGeneration: inventory.generation,
              environment: structuredClone(entry.claim.environment),
              assignmentGeneration: observation.assignmentGeneration,
            }), entry.claim.environment);
            if (!qualification.qualified) throw new Error(qualification.reason ?? 'physical device did not requalify during reconciliation');
            entry.state = 'OWNED';
            entry.reason = null;
            entry.claim.qualificationGeneration = qualification.qualificationGeneration;
            entry.updatedAt = new Date().toISOString();
            await this.#save(catalog);
            return publicStatus(entry, inventory, observation);
          } catch (error) {
            this.#quarantine(entry, error?.message, 'RECOVERY_REQUIRED');
            await this.#save(catalog);
            return publicStatus(entry, inventory, observation);
          }
        }
      }
      this.#quarantine(entry, 'durable device ownership does not match provider observation');
      await this.#save(catalog);
      return publicStatus(entry, inventory, observation);
    });
  }
}
