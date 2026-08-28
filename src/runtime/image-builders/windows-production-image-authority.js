import { createHash } from 'node:crypto';
import { normalizeWindowsInstallMediaAuthority } from './windows-install-media-authority.js';
import { normalizeWindowsToolchainAuthority } from '../../setup/windows-toolchain-authority.js';

export const WINDOWS_PRODUCTION_IMAGE_AUTHORITY_PROTOCOL = 'devbridge/windows-production-image-authority-v1';

const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function normalizeWindowsProductionImageAuthority(raw) {
  const value = onlyKeys(raw, new Set(['protocol', 'media', 'tools', 'payload', 'recipe', 'output']), 'production image authority');
  if (value.protocol !== WINDOWS_PRODUCTION_IMAGE_AUTHORITY_PROTOCOL) throw new TypeError('production image authority protocol is unsupported');
  const payload = onlyKeys(value.payload, new Set(['generation']), 'production image payload authority');
  const recipe = onlyKeys(value.recipe, new Set(['generation']), 'production image recipe authority');
  if (recipe.generation !== 'audit-handoff-v1') throw new TypeError('production image recipe generation is unsupported');
  const output = onlyKeys(value.output, new Set(['profile', 'generation', 'bootstrap']), 'production image output authority');
  return Object.freeze({
    protocol: WINDOWS_PRODUCTION_IMAGE_AUTHORITY_PROTOCOL,
    media: normalizeWindowsInstallMediaAuthority(value.media),
    tools: normalizeWindowsToolchainAuthority(value.tools),
    payload: Object.freeze({ generation: safeId(payload.generation, 'production image payload generation') }),
    recipe: Object.freeze({ generation: safeId(recipe.generation, 'production image recipe generation') }),
    output: Object.freeze({
      profile: safeId(output.profile, 'production image output profile'),
      generation: safeId(output.generation, 'production image output generation'),
      bootstrap: safeId(output.bootstrap, 'production image output bootstrap'),
    }),
  });
}

export function windowsProductionImageAuthoritySubject(raw) {
  const authority = normalizeWindowsProductionImageAuthority(raw);
  return `subject-${createHash('sha256').update(JSON.stringify(stable(authority)), 'utf8').digest('hex').slice(0, 32)}`;
}

export function requireWindowsProductionImageAuthoritySubject(value) {
  if (typeof value !== 'string' || !SUBJECT.test(value)) throw new TypeError('production image authority reference is invalid');
  return value;
}
