import { createHash } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { applyFixedLengthMediaPatches } from './fixed-length-media-patcher.js';

const PROTOCOL = 'devbridge/ubuntu-autoinstall-recipe-v1';
const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function validateRecipe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== PROTOCOL) throw new Error('autoinstall recipe is invalid');
  const allowed = new Set(['protocol', 'sourceSha256', 'patches', 'generation']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`autoinstall recipe field is not allowed: ${key}`);
  if (typeof value.sourceSha256 !== 'string' || !SHA256.test(value.sourceSha256)) throw new Error('autoinstall source digest is invalid');
  if (typeof value.generation !== 'string' || value.generation.length < 1 || value.generation.length > 128) throw new Error('autoinstall recipe generation is invalid');
  if (!Array.isArray(value.patches) || value.patches.length === 0 || value.patches.length > 32) throw new Error('autoinstall patch set is invalid');
  return structuredClone(value);
}

async function realDirectory(location) {
  const info = await lstat(location);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('autoinstall destination must be a real directory');
}

function validateSeed(seed) {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) throw new Error('autoinstall seed is invalid');
  if (typeof seed.userData !== 'string' || typeof seed.metaData !== 'string') throw new Error('autoinstall seed data is invalid');
  const evidence = seed.evidence === undefined ? null : structuredClone(seed.evidence);
  return { userData: seed.userData, metaData: seed.metaData, evidence };
}

export class UbuntuAutoinstallMediaPreparer {
  #recipeLookup;
  #seedFactory;
  #seedWriter;
  #patcher;

  constructor({ recipeLookup, seedFactory, seedWriter, patcher = applyFixedLengthMediaPatches } = {}) {
    if (typeof recipeLookup !== 'function') throw new TypeError('recipeLookup must be a function');
    if (typeof seedFactory !== 'function') throw new TypeError('seedFactory must be a function');
    if (!seedWriter || typeof seedWriter.create !== 'function') throw new TypeError('seedWriter must expose create');
    if (typeof patcher !== 'function') throw new TypeError('patcher must be a function');
    this.#recipeLookup = recipeLookup;
    this.#seedFactory = seedFactory;
    this.#seedWriter = seedWriter;
    this.#patcher = patcher;
  }

  async prepare({ source, recipeRef, destination }) {
    if (!source || typeof source !== 'object' || typeof source.location !== 'string') throw new TypeError('release source is invalid');
    if (!source.identity || typeof source.identity.sha256 !== 'string' || !SHA256.test(source.identity.sha256)) throw new TypeError('release source identity is invalid');
    if (typeof recipeRef !== 'string' || !SUBJECT.test(recipeRef)) throw new TypeError('autoinstall recipe reference is invalid');
    if (typeof destination !== 'string' || destination.length === 0) throw new TypeError('autoinstall destination is invalid');

    const recipe = validateRecipe(await this.#recipeLookup(recipeRef));
    if (recipe.sourceSha256 !== source.identity.sha256) throw new Error('autoinstall recipe does not match the approved release media');
    const recipeDigest = digest(recipe);
    await mkdir(destination, { recursive: false, mode: 0o700 });
    await realDirectory(destination);

    try {
      const installer = path.join(destination, 'installer.iso');
      const patchEvidence = await this.#patcher({ source: source.location, destination: installer, patches: recipe.patches });
      if (patchEvidence.source.sha256 !== recipe.sourceSha256) throw new Error('autoinstall source bytes changed after release admission');

      const seed = validateSeed(await this.#seedFactory({ recipeRef, recipeGeneration: recipe.generation, sourceIdentity: structuredClone(source.identity) }));
      const seedResult = await this.#seedWriter.create({
        workspace: destination,
        destination: path.join(destination, 'cidata.iso'),
        userData: seed.userData,
        metaData: seed.metaData,
      });

      return {
        installer: { location: installer, bytes: patchEvidence.derived.bytes, sha256: patchEvidence.derived.sha256 },
        seed: { location: seedResult.location, bytes: seedResult.bytes, sha256: seedResult.sha256, volumeLabel: seedResult.volumeLabel },
        evidence: {
          protocol: PROTOCOL,
          recipeGeneration: recipe.generation,
          recipeSha256: recipeDigest,
          sourceSha256: patchEvidence.source.sha256,
          patches: patchEvidence.applied,
          seed: seed.evidence,
        },
      };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}

export function createUbuntuAutoinstallMediaPreparer(options) {
  return new UbuntuAutoinstallMediaPreparer(options);
}
