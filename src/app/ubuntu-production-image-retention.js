import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { BaseImageLibrary } from '../runtime/base-image-library.js';
import { createExactArtifactSet } from '../runtime/exact-artifact-set.js';
import { invokeCommand } from '../runtime/command-invocation.js';
import { readLocalIdentity } from '../runtime/local-identity.js';
import { createHyperVImageConstruction } from '../runtime/providers/hyperv-image-construction.js';
import { createWindowsFilesystemEntryObserver } from '../runtime/providers/windows-filesystem-entry-observer.js';
import { createCanonicalImageCanaryStateStore } from '../state/canonical-image-canary-state-store.js';
import { createConstructionRetentionStateStore } from '../state/construction-retention-state-store.js';
import { JsonStateStore } from '../state/json-state-store.js';
import { createUbuntuConstructionAuthorityStateStore } from '../state/ubuntu-construction-authority-state-store.js';
import { createConstructionRetention } from './construction-retention.js';

const MANIFEST_PROTOCOL = 'devbridge/ubuntu-production-image-retention-manifest-v1';
const SNAPSHOT_GENERATION = 'ubuntu-production-image-retention-v1';
const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const IMAGE = /^img-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_EFFECT = /^effect-[a-f0-9]{64}$/u;
const CANARY_PHASES = new Set([
  'planned',
  'prepared',
  'running',
  'active',
  'probed',
  'finalization-planned',
  'finalization-attempted',
  'finalized',
  'accepted',
  'retained',
  'published',
  'completed',
]);
const AMBIGUOUS_PHASES = new Set(['finalization-attempted']);

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function subjectId(value, name = 'production image retention subject') {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function effectDescriptor(kind, role, payload, bytes = 0, terminal = false) {
  const identity = `effect-${digest({ kind, role, payload })}`;
  return Object.freeze({ identity, kind, role, payload: structuredClone(payload), bytes, terminal });
}

function publicEffect(value) {
  return Object.freeze({ identity: value.identity, bytes: value.bytes, terminal: value.terminal });
}

function asMap(entries, identityField, name) {
  if (!Array.isArray(entries)) throw new TypeError(`${name} entries are invalid`);
  const result = new Map();
  for (const entry of entries) {
    const identity = subjectId(entry?.[identityField], `${name} identity`);
    if (result.has(identity)) throw new Error(`${name} contains duplicate subjects`);
    result.set(identity, entry.value ?? entry);
  }
  return result;
}

function validateJournal(raw, identity) {
  if (raw == null) return null;
  const value = onlyKeys(raw, new Set(['protocol', 'identity', 'requestDigest', 'revision', 'phase', 'probe', 'finalization', 'image']), 'production image journal');
  if (value.protocol !== 'devbridge/canonical-image-canary-v1' || value.identity !== identity || !CANARY_PHASES.has(value.phase)) throw new Error('production image journal identity is invalid');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.requestDigest !== 'string' || !SHA256.test(value.requestDigest)) throw new Error('production image journal evidence is invalid');
  if (value.image != null && (typeof value.image !== 'object' || !IMAGE.test(value.image.identity))) throw new Error('production image journal reference is invalid');
  return value;
}

function validatePreparation(raw, identity) {
  if (raw == null) return null;
  const value = onlyKeys(
    raw,
    new Set(['protocol', 'identity', 'payloadGeneration', 'packageGeneration', 'packageSnapshot', 'resources', 'network', 'installer', 'seed', 'access']),
    'production image preparation',
  );
  if (value.protocol !== 'devbridge/ubuntu-production-image-physical-preparation-v2' || value.identity !== identity) throw new Error('production image preparation identity is invalid');
  if (!value.installer || !value.seed || !value.access) throw new Error('production image preparation evidence is incomplete');
  for (const [entry, name] of [[value.installer, 'installer'], [value.seed, 'seed']]) {
    if (typeof entry.location !== 'string' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      throw new Error(`production image ${name} evidence is invalid`);
    }
  }
  for (const key of ['identityFile', 'knownHostsFile', 'identitySha256', 'knownHostsSha256']) {
    if (typeof value.access[key] !== 'string' || value.access[key].length === 0) throw new Error('production image access evidence is invalid');
  }
  if (!SHA256.test(value.access.identitySha256) || !SHA256.test(value.access.knownHostsSha256)) throw new Error('production image access digest is invalid');
  return value;
}

function normalizeBoundManifest(raw, identity) {
  if (raw == null) return null;
  const value = onlyKeys(raw, new Set(['protocol', 'identity', 'planDigest', 'recordReferences', 'facts', 'effects']), 'production image retention manifest');
  if (value.protocol !== MANIFEST_PROTOCOL || value.identity !== identity || typeof value.planDigest !== 'string' || !SHA256.test(value.planDigest)) {
    throw new Error('production image retention manifest identity is invalid');
  }
  if (!Array.isArray(value.recordReferences) || value.recordReferences.some((entry) => typeof entry !== 'string')) throw new Error('production image retention manifest references are invalid');
  const facts = onlyKeys(value.facts, new Set(['recoverable', 'retained', 'ambiguous']), 'production image retention manifest facts');
  if (Object.values(facts).some((entry) => typeof entry !== 'boolean')) throw new Error('production image retention manifest facts are invalid');
  if (!Array.isArray(value.effects) || value.effects.length === 0) throw new Error('production image retention manifest effects are invalid');
  const effects = value.effects.map((entry, index) => {
    const effect = onlyKeys(entry, new Set(['identity', 'kind', 'role', 'payload', 'bytes', 'terminal']), `production image retention effect ${index}`);
    if (typeof effect.identity !== 'string' || !SAFE_EFFECT.test(effect.identity) || !['provider', 'artifact', 'records'].includes(effect.kind)
        || typeof effect.role !== 'string' || !Number.isSafeInteger(effect.bytes) || effect.bytes < 0 || typeof effect.terminal !== 'boolean') {
      throw new Error('production image retention effect is invalid');
    }
    if (effect.identity !== effectDescriptor(effect.kind, effect.role, effect.payload, effect.bytes, effect.terminal).identity) throw new Error('production image retention effect identity changed');
    return Object.freeze({ ...effect, payload: structuredClone(effect.payload) });
  });
  if (effects.slice(0, -1).some((entry) => entry.terminal) || effects.at(-1).terminal !== true) throw new Error('production image retention terminal effect is invalid');
  return Object.freeze({
    protocol: MANIFEST_PROTOCOL,
    identity,
    planDigest: value.planDigest,
    recordReferences: Object.freeze([...value.recordReferences].sort()),
    facts: Object.freeze({ ...facts }),
    effects: Object.freeze(effects),
  });
}

function recordReference(kind, raw) {
  return `${kind}:${digest(raw)}`;
}

function accessDirectory(root, identity) {
  return path.join(root, createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32));
}

async function exists(location, kind = null) {
  try {
    const info = await lstat(location);
    if (info.isSymbolicLink() || (kind === 'directory' && !info.isDirectory()) || (kind === 'file' && !info.isFile())) throw new Error('production image artifact shape is invalid');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function exactPath(left, right, platform) {
  const selected = platform === 'win32' ? path.win32 : path.posix;
  const a = selected.resolve(left);
  const b = selected.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function createUbuntuProductionImageRetention({ stateDirectory, currentSubject, onProgress = null } = {}, {
  platform = process.platform,
  invoke = invokeCommand,
  identityReader = readLocalIdentity,
  constructionFactory = createHyperVImageConstruction,
  imageLibraryFactory = (directory) => new BaseImageLibrary({ directory }),
  artifactSetFactory = (options) => createExactArtifactSet(options),
  attributeObserverFactory = createWindowsFilesystemEntryObserver,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.length === 0 || stateDirectory.includes('\0')) throw new TypeError('production image retention state directory is invalid');
  const selectedSubject = subjectId(currentSubject, 'current production image subject');
  if ((onProgress != null && typeof onProgress !== 'function') || typeof invoke !== 'function' || typeof identityReader !== 'function' || typeof constructionFactory !== 'function'
      || typeof imageLibraryFactory !== 'function' || typeof artifactSetFactory !== 'function' || typeof attributeObserverFactory !== 'function') {
    throw new TypeError('production image retention composition contract is incomplete');
  }

  const stateRoot = path.resolve(stateDirectory);
  const root = path.join(stateRoot, 'production-image-canary');
  const sourceRoot = path.join(root, 'source');
  const outputRoot = path.join(root, 'output');
  const accessRoot = path.join(root, 'access');
  const foundationRoot = path.join(stateRoot, 'environment-foundation');
  const retentionRoot = path.join(root, 'retention');
  const runLock = path.join(root, 'run.lock');
  const authorityStore = createUbuntuConstructionAuthorityStateStore(path.join(root, 'authority.json'));
  const journalStore = createCanonicalImageCanaryStateStore(path.join(root, 'journal.json'));
  const preparationStore = new JsonStateStore(path.join(root, 'preparation.json'));
  const manifestStore = new JsonStateStore(path.join(retentionRoot, 'manifests.json'));
  const retentionStore = createConstructionRetentionStateStore(path.join(retentionRoot, 'state.json'));
  const identity = await identityReader({ directory: foundationRoot });
  if (typeof identity !== 'string' || !/^[a-f0-9]{32}$/u.test(identity)) throw new Error('production image retention local identity is unavailable');
  const construction = constructionFactory({ directory: path.join(root, 'construction'), sourceRoot, outputRoot, identity, invoke });
  if (!construction || ['listRetirementRecords', 'retirementStatus', 'retireProvider', 'retireRecord'].some((method) => typeof construction[method] !== 'function')) {
    throw new TypeError('production image retention construction contract is incomplete');
  }
  const images = imageLibraryFactory(path.join(foundationRoot, 'images'));
  if (!images || typeof images.list !== 'function') throw new TypeError('production image retention image contract is incomplete');
  const attributeObserver = platform === 'win32' ? attributeObserverFactory({ invoke }) : null;
  const artifactSet = artifactSetFactory({
    platform,
    ...(platform === 'win32' ? { inspectReparse: (location) => attributeObserver.isReparse(location) } : {}),
  });
  if (!artifactSet || ['plan', 'discover', 'observe', 'remove'].some((method) => typeof artifactSet[method] !== 'function')) {
    throw new TypeError('production image retention artifact contract is incomplete');
  }
  const pending = new Map();

  async function rawRecords(identityToRead) {
    const records = new Map((await construction.listRetirementRecords()).map((entry) => [entry.identity, entry]));
    return Object.freeze({
      authority: await authorityStore.load(identityToRead),
      journal: await journalStore.load(identityToRead),
      preparation: await preparationStore.get(identityToRead),
      construction: records.get(identityToRead) ?? null,
    });
  }

  async function planArtifacts(identityToPlan, preparation, constructionRecord, status) {
    const effects = [];
    if (constructionRecord && status?.provider?.exists === true) {
      effects.push(effectDescriptor('provider', 'materialization', {
        identity: identityToPlan,
        record: digest(constructionRecord),
      }));
    }

    if (constructionRecord) {
      const configurationRoot = path.join(outputRoot, `${constructionRecord.key}-vm`);
      if (await exists(configurationRoot, 'directory')) {
        const manifest = await artifactSet.discover({ identity: `set-${digest({ identityToPlan, role: 'configuration' }).slice(0, 32)}`, root: configurationRoot });
        effects.push(effectDescriptor('artifact', 'configuration', manifest, manifest.bytes));
      }
      if (status?.disk?.exists === true) {
        const manifest = await artifactSet.plan({
          identity: `set-${digest({ identityToPlan, role: 'output' }).slice(0, 32)}`,
          root: outputRoot,
          files: [{ relative: constructionRecord.diskName, bytes: status.disk.allocatedBytes, sha256: null }],
          directories: [],
          exclusive: false,
          removeRoot: false,
        });
        effects.push(effectDescriptor('artifact', 'output', manifest, manifest.bytes));
      }
    }

    if (preparation) {
      const subjectRoot = path.join(sourceRoot, identityToPlan);
      const preparedRoot = path.join(subjectRoot, 'prepared');
      const expectedInstaller = path.join(preparedRoot, 'installer.iso');
      const expectedSeed = path.join(preparedRoot, 'cidata.iso');
      if (!exactPath(preparation.installer.location, expectedInstaller, platform) || !exactPath(preparation.seed.location, expectedSeed, platform)) {
        throw new Error('production image preparation paths changed');
      }
      const sourceManifest = await artifactSet.plan({
        identity: `set-${digest({ identityToPlan, role: 'source' }).slice(0, 32)}`,
        root: subjectRoot,
        files: [
          { relative: 'prepared/installer.iso', bytes: preparation.installer.bytes, sha256: preparation.installer.sha256 },
          { relative: 'prepared/cidata.iso', bytes: preparation.seed.bytes, sha256: preparation.seed.sha256 },
        ],
        directories: ['prepared'],
        exclusive: true,
        removeRoot: true,
      });
      effects.push(effectDescriptor('artifact', 'source', sourceManifest, sourceManifest.bytes));

      const expectedAccess = accessDirectory(accessRoot, identityToPlan);
      const privateFile = path.join(expectedAccess, 'client_ed25519');
      const publicFile = path.join(expectedAccess, 'client_ed25519.pub');
      const knownHostsFile = path.join(expectedAccess, 'known_hosts');
      if (!exactPath(preparation.access.identityFile, privateFile, platform) || !exactPath(preparation.access.knownHostsFile, knownHostsFile, platform)) {
        throw new Error('production image access paths changed');
      }
      const accessManifest = await artifactSet.plan({
        identity: `set-${digest({ identityToPlan, role: 'access' }).slice(0, 32)}`,
        root: expectedAccess,
        files: [
          { relative: 'client_ed25519', bytes: null, sha256: preparation.access.identitySha256 },
          { relative: 'client_ed25519.pub', bytes: null, sha256: null },
          { relative: 'known_hosts', bytes: null, sha256: preparation.access.knownHostsSha256 },
        ],
        directories: [],
        exclusive: true,
        removeRoot: true,
      });
      effects.push(effectDescriptor('artifact', 'access', accessManifest, accessManifest.bytes));
      void publicFile;
    }
    return effects;
  }

  async function buildSnapshot() {
    const authorityEntries = await authorityStore.list();
    const journalEntries = await journalStore.list();
    const preparationEntries = await preparationStore.entries();
    const constructionEntries = await construction.listRetirementRecords();
    const authority = asMap(authorityEntries, 'subjectRef', 'production image authority');
    const journals = asMap(journalEntries, 'identity', 'production image journal');
    const preparations = asMap(preparationEntries.map(([identityToMap, value]) => ({ identity: identityToMap, value })), 'identity', 'production image preparation');
    const constructions = asMap(constructionEntries, 'identity', 'production image construction');
    const allSubjects = [...new Set([selectedSubject, ...authority.keys(), ...journals.keys(), ...preparations.keys(), ...constructions.keys()])].sort();
    const imageEntries = await images.list();
    if (!Array.isArray(imageEntries)) throw new Error('production image reference inventory is invalid');
    const protectedReferences = [];
    const imageAuthorities = new Map();
    for (const image of imageEntries) {
      if (!image || typeof image !== 'object' || !IMAGE.test(image.identity)) throw new Error('production image reference identity is invalid');
      const reference = `image:${image.identity}`;
      protectedReferences.push(reference);
      if (typeof image.provenance?.authority === 'string' && SUBJECT.test(image.provenance.authority)) {
        const list = imageAuthorities.get(image.provenance.authority) ?? [];
        list.push(reference);
        imageAuthorities.set(image.provenance.authority, list);
      }
    }
    let leaseActive = false;
    try {
      await lstat(runLock);
      leaseActive = true;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }

    const subjects = [];
    pending.clear();
    for (const identityToPlan of allSubjects) {
      const bound = normalizeBoundManifest(await manifestStore.get(`manifest:${identityToPlan}`), identityToPlan);
      let facts = bound?.facts ?? null;
      let recordReferences = bound?.recordReferences ?? null;
      let effects = bound?.effects ?? null;
      let ambiguous = false;
      let journal = null;
      let preparation = null;
      let status = null;
      const constructionRecord = constructions.get(identityToPlan) ?? null;
      try {
        journal = validateJournal(journals.get(identityToPlan) ?? null, identityToPlan);
        preparation = validatePreparation(preparations.get(identityToPlan) ?? null, identityToPlan);
        if (!authority.has(identityToPlan) || !journal) ambiguous = true;
        if (AMBIGUOUS_PHASES.has(journal?.phase)) ambiguous = true;
        if (constructionRecord) status = await construction.retirementStatus(identityToPlan);
        if (constructionRecord && status?.provider?.exists === true && status.provider.state !== 'off') facts = { recoverable: true, retained: false, ambiguous: false };
        if (!effects) effects = await planArtifacts(identityToPlan, preparation, constructionRecord, status);
      } catch {
        ambiguous = true;
      }

      if (!recordReferences) {
        recordReferences = [
          authority.has(identityToPlan) ? recordReference('authority', authority.get(identityToPlan)) : null,
          journal ? recordReference('journal', journal) : null,
          preparation ? recordReference('preparation', preparation) : null,
          constructionRecord ? recordReference('construction', constructionRecord) : null,
        ].filter(Boolean).sort();
      }
      if (!facts) {
        facts = Object.freeze({
          recoverable: status?.provider?.exists === true && status.provider.state !== 'off',
          retained: journal?.phase === 'retained' || constructionRecord?.phase === 'retained',
          ambiguous,
        });
      } else if (ambiguous) facts = Object.freeze({ ...facts, ambiguous: true });

      const terminalPayload = Object.freeze({
        identity: identityToPlan,
        authority: authority.has(identityToPlan) ? digest(authority.get(identityToPlan)) : null,
        journal: journal ? digest(journal) : null,
        preparation: preparation ? digest(preparation) : null,
        construction: constructionRecord ? digest(constructionRecord) : null,
      });
      if (!effects || effects.length === 0 || effects.at(-1)?.terminal !== true) {
        effects = Object.freeze([...(effects ?? []), effectDescriptor('records', 'control', terminalPayload, 0, true)]);
      }
      if (facts.ambiguous && !bound) effects = Object.freeze([effectDescriptor('records', 'control', terminalPayload, 0, true)]);
      const references = [...new Set([...recordReferences, ...(imageAuthorities.get(identityToPlan) ?? []), ...(journal?.image?.identity ? [`image:${journal.image.identity}`] : [])])].sort();
      const normalizedFacts = Object.freeze({ recoverable: facts.recoverable === true, retained: facts.retained === true, ambiguous: facts.ambiguous === true });
      pending.set(identityToPlan, Object.freeze({ recordReferences: Object.freeze([...recordReferences]), facts: normalizedFacts, effects: Object.freeze(effects) }));
      subjects.push(Object.freeze({
        identity: identityToPlan,
        selected: identityToPlan === selectedSubject,
        recoverable: normalizedFacts.recoverable,
        retained: normalizedFacts.retained,
        ambiguous: normalizedFacts.ambiguous,
        references: Object.freeze(references),
        effects: Object.freeze(effects.map(publicEffect)),
      }));
    }
    return Object.freeze({ generation: SNAPSHOT_GENERATION, leaseActive, protectedReferences: Object.freeze([...new Set(protectedReferences)].sort()), subjects: Object.freeze(subjects) });
  }

  async function binding(identityToLoad, planDigest) {
    const manifest = normalizeBoundManifest(await manifestStore.get(`manifest:${identityToLoad}`), identityToLoad);
    if (!manifest || manifest.planDigest !== planDigest) throw new Error('production image retention effect manifest is unavailable');
    return manifest;
  }

  async function observeRecordEffect(descriptor) {
    const expected = descriptor.payload;
    const records = await rawRecords(expected.identity);
    let present = 0;
    for (const [key, value] of Object.entries(records)) {
      const expectedDigest = expected[key];
      if (value == null) continue;
      present += 1;
      if (expectedDigest == null || digest(value) !== expectedDigest) return Object.freeze({ state: 'ambiguous', retryable: false });
    }
    return Object.freeze({ state: present === 0 ? 'absent' : 'present', retryable: true });
  }

  async function observeDescriptor(descriptor) {
    if (descriptor.kind === 'provider') {
      const observed = await construction.retirementStatus(descriptor.payload.identity);
      if (!observed.exists || observed.provider?.exists !== true) return Object.freeze({ state: 'absent', retryable: false });
      return observed.provider.state === 'off'
        ? Object.freeze({ state: 'present', retryable: true })
        : Object.freeze({ state: 'ambiguous', retryable: false });
    }
    if (descriptor.kind === 'artifact') {
      const result = await artifactSet.observe(descriptor.payload);
      return Object.freeze({ state: result.state, retryable: result.retryable });
    }
    return observeRecordEffect(descriptor);
  }

  const effects = Object.freeze({
    async bind(request) {
      const value = onlyKeys(request, new Set(['identity', 'planDigest', 'effects']), 'production image retention binding request');
      const identityToBind = subjectId(value.identity);
      if (typeof value.planDigest !== 'string' || !SHA256.test(value.planDigest) || !Array.isArray(value.effects)) throw new TypeError('production image retention binding request is invalid');
      const planned = pending.get(identityToBind);
      if (!planned || JSON.stringify(planned.effects.map(publicEffect)) !== JSON.stringify(value.effects)) throw new Error('production image retention binding changed after observation');
      const existing = normalizeBoundManifest(await manifestStore.get(`manifest:${identityToBind}`), identityToBind);
      if (existing) {
        if (existing.planDigest !== value.planDigest || JSON.stringify(existing.effects.map(publicEffect)) !== JSON.stringify(value.effects)) throw new Error('production image retention binding conflicts with durable evidence');
      } else {
        await manifestStore.set(`manifest:${identityToBind}`, {
          protocol: MANIFEST_PROTOCOL,
          identity: identityToBind,
          planDigest: value.planDigest,
          recordReferences: planned.recordReferences,
          facts: planned.facts,
          effects: planned.effects,
        });
      }
      return Object.freeze({ identity: identityToBind, planDigest: value.planDigest, bound: true });
    },
    async observe(request) {
      const manifest = await binding(subjectId(request?.identity), request?.planDigest);
      const descriptor = manifest.effects.find((entry) => entry.identity === request?.effect?.identity);
      if (!descriptor) throw new Error('production image retention effect is not bound');
      try {
        const observed = await observeDescriptor(descriptor);
        return Object.freeze({ identity: descriptor.identity, state: observed.state, retryable: observed.retryable });
      } catch {
        return Object.freeze({ identity: descriptor.identity, state: 'ambiguous', retryable: false });
      }
    },
    async remove(request) {
      const manifest = await binding(subjectId(request?.identity), request?.planDigest);
      const descriptor = manifest.effects.find((entry) => entry.identity === request?.effect?.identity);
      if (!descriptor) throw new Error('production image retention effect is not bound');
      if (descriptor.kind === 'provider') return construction.retireProvider(manifest.identity);
      if (descriptor.kind === 'artifact') {
        if (['configuration', 'output'].includes(descriptor.role)) {
          const status = await construction.retirementStatus(manifest.identity);
          if (status.exists && (status.provider?.exists === true || status.disk?.attached === true)) throw new Error('production image provider artifacts remain active');
        }
        return artifactSet.remove(descriptor.payload);
      }
      for (const earlier of manifest.effects.filter((entry) => entry.identity !== descriptor.identity)) {
        const observed = await observeDescriptor(earlier);
        if (observed.state !== 'absent') throw new Error('production image retention artifacts remain before record retirement');
      }
      const expected = descriptor.payload;
      const current = await rawRecords(manifest.identity);
      for (const [key, value] of Object.entries(current)) {
        if (value != null && (expected[key] == null || digest(value) !== expected[key])) throw new Error('production image retention record changed before retirement');
      }
      if (current.construction != null) await construction.retireRecord(manifest.identity);
      if (current.preparation != null) await preparationStore.delete(manifest.identity);
      if (current.journal != null) await journalStore.delete(manifest.identity);
      if (current.authority != null) await authorityStore.delete(manifest.identity);
      return Object.freeze({ identity: manifest.identity, retired: true });
    },
  });

  const retention = createConstructionRetention({ source: Object.freeze({ snapshot: buildSnapshot }), journal: retentionStore, effects, onProgress });
  return Object.freeze({ inspect: () => retention.inspect(), retire: (request) => retention.retire(request) });
}
