import { ENVIRONMENT_DECLARATION_PROTOCOL, normalizeEnvironmentDeclaration } from '../runtime/environment-declaration.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;
const MAX_IMAGES = 4_096;

function exactObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeSpecification(raw) {
  const value = exactObject(raw, new Set([
    'profile', 'schemaGeneration', 'guest', 'imageGeneration', 'bootstrapGeneration', 'resources',
    'boot', 'network', 'requirements', 'enrollment', 'protectedStateClasses',
  ]), 'profile source specification');
  if (!Array.isArray(value.requirements) || !Array.isArray(value.protectedStateClasses)) {
    throw new TypeError('profile source specification collections are invalid');
  }
  return Object.freeze({
    profile: safeId(value.profile, 'profile source specification.profile'),
    schemaGeneration: safeId(value.schemaGeneration, 'profile source specification.schemaGeneration'),
    guest: exactObject(value.guest, new Set(['family', 'generation']), 'profile source specification.guest'),
    imageGeneration: safeId(value.imageGeneration, 'profile source specification.imageGeneration'),
    bootstrapGeneration: safeId(value.bootstrapGeneration, 'profile source specification.bootstrapGeneration'),
    resources: exactObject(value.resources, new Set(['memoryBytes', 'processorCount']), 'profile source specification.resources'),
    boot: safeId(value.boot, 'profile source specification.boot'),
    network: safeId(value.network, 'profile source specification.network'),
    requirements: Object.freeze([...value.requirements]),
    enrollment: safeId(value.enrollment, 'profile source specification.enrollment'),
    protectedStateClasses: Object.freeze([...value.protectedStateClasses]),
  });
}

function retainedImage(current, specification) {
  const declarations = current?.configuration?.declarations;
  if (declarations == null) return null;
  if (!Array.isArray(declarations)) throw new TypeError('profile source current declarations are invalid');
  const matches = declarations.filter((entry) => entry?.profile === specification.profile);
  if (matches.length > 1) throw new Error('profile source current declaration is ambiguous');
  if (matches.length === 0) return null;
  const retained = matches[0];
  if (retained.image?.generation !== specification.imageGeneration
      || retained.bootstrap?.generation !== specification.bootstrapGeneration) {
    throw new Error('accepted profile no longer matches current output authority');
  }
  return Object.freeze({
    identity: retained.image.identity,
    generation: retained.image.generation,
    provenance: Object.freeze({ bootstrap: retained.bootstrap.generation }),
  });
}

function selectedImage(images, current, specification) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new TypeError('profile source image inventory is invalid');
  const matches = images.filter((entry) => entry?.retiredAt == null
    && entry?.profile === specification.profile
    && entry?.generation === specification.imageGeneration);
  if (matches.length > 1) throw new Error('profile source image generation is ambiguous');
  return matches[0] ?? retainedImage(current, specification);
}

export function createEnvironmentProfileSource({ specification } = {}) {
  if (typeof specification !== 'function') throw new TypeError('profile source specification contract is incomplete');
  return Object.freeze({
    async resolve({ images, current = null, subjects = [], identify } = {}) {
      if (!Array.isArray(subjects) || typeof identify !== 'function') throw new TypeError('profile source resolution contract is incomplete');
      const selected = normalizeSpecification(await specification());
      const image = selectedImage(images, current, selected);
      if (image == null) return null;
      if (image?.provenance?.bootstrap !== selected.bootstrapGeneration) {
        throw new Error('profile source image bootstrap identity does not match current output authority');
      }
      return normalizeEnvironmentDeclaration({
        protocol: ENVIRONMENT_DECLARATION_PROTOCOL,
        profile: selected.profile,
        schemaGeneration: selected.schemaGeneration,
        guest: selected.guest,
        image: { identity: image.identity, generation: image.generation },
        resources: selected.resources,
        boot: { requirement: selected.boot },
        network: { requirement: selected.network },
        bootstrap: { generation: selected.bootstrapGeneration, requirements: selected.requirements },
        enrollment: { requirement: selected.enrollment },
        workspaces: subjects.map((authority) => ({ identity: identify(authority, selected.profile), authority })),
        protectedStateClasses: selected.protectedStateClasses,
      });
    },
  });
}
