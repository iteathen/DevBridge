import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL = 'devbridge/environment-activity-policy-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_ROUTES = 256;

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function stableSubject(value, name) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new TypeError(`${name} must be a numeric stable identity`);
  return value;
}

export function environmentActivityPolicyPath(stateDirectory) {
  return path.join(path.resolve(stateDirectory), 'environment-activity', 'policy.json');
}

export function normalizeEnvironmentActivityPolicy(raw) {
  const value = requireObject(raw, 'environment activity policy');
  onlyKeys(value, new Set(['protocol', 'routes']), 'environment activity policy');
  if (value.protocol !== ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL) throw new TypeError('environment activity policy protocol is unsupported');
  if (!Array.isArray(value.routes) || value.routes.length > MAX_ROUTES) throw new TypeError('environment activity policy routes are invalid');
  const seen = new Set();
  const routes = value.routes.map((rawRoute, index) => {
    const route = requireObject(rawRoute, `environment activity route[${index}]`);
    onlyKeys(route, new Set(['subject', 'profile', 'preferred', 'validation']), `environment activity route[${index}]`);
    const normalized = Object.freeze({
      subject: stableSubject(route.subject, `environment activity route[${index}].subject`),
      profile: safeId(route.profile, `environment activity route[${index}].profile`),
      preferred: route.preferred === true,
      validation: route.validation === true,
    });
    const key = `${normalized.subject}\0${normalized.profile}`;
    if (seen.has(key)) throw new TypeError('environment activity policy contains a duplicate subject/profile route');
    seen.add(key);
    return normalized;
  });
  const preferred = new Set();
  for (const route of routes) {
    if (!route.preferred) continue;
    if (preferred.has(route.subject)) throw new TypeError(`environment activity policy contains multiple preferred profiles for ${route.subject}`);
    preferred.add(route.subject);
  }
  if (routes.filter((route) => route.validation).length > 1) throw new TypeError('environment activity policy contains multiple validation routes');
  return Object.freeze({ protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes: Object.freeze(routes) });
}

export async function loadEnvironmentActivityPolicy(stateDirectory) {
  const file = environmentActivityPolicyPath(stateDirectory);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_POLICY_BYTES) throw new Error('environment activity policy must be a bounded real file');
    return normalizeEnvironmentActivityPolicy(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function publishEnvironmentActivityPolicy(stateDirectory, raw) {
  const policy = normalizeEnvironmentActivityPolicy(raw);
  const file = environmentActivityPolicyPath(stateDirectory);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('environment activity policy directory must be a real directory');
  try {
    const current = await lstat(file);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('environment activity policy must be a real file');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(directory, `.policy-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(policy)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  return policy;
}

export function environmentActivityRouteForSubject(rawPolicy, subject) {
  const policy = normalizeEnvironmentActivityPolicy(rawPolicy);
  const stable = stableSubject(subject, 'environment activity route subject');
  const matches = policy.routes.filter((route) => route.subject === stable);
  if (matches.length === 0) throw new Error('no local environment activity route exists for the subject');
  if (matches.length === 1) return matches[0];
  const preferred = matches.filter((route) => route.preferred);
  if (preferred.length !== 1) throw new Error('environment activity subject has multiple profiles and no unique preferred route');
  return preferred[0];
}

export function validationEnvironmentActivityRoute(rawPolicy) {
  if (rawPolicy == null) throw new Error('no local environment activity policy is configured');
  const policy = normalizeEnvironmentActivityPolicy(rawPolicy);
  const matches = policy.routes.filter((route) => route.validation);
  if (matches.length !== 1) throw new Error('exactly one local validation activity route is required');
  return matches[0];
}

