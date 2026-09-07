import { createHash } from 'node:crypto';
import path from 'node:path';

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.+-]{0,159}$/u;
const RESOURCE_LIMIT = 4 * 1024 * 1024;
const RESOURCE_COUNT = 32;
const DESCRIPTOR_LIMIT = 8 * 1024 * 1024;

function resourcePath(value, messages) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\\')) throw new Error(messages.resourcePath);
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('/') || normalized.startsWith('../') || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(messages.normalizedResourcePath);
  }
  return normalized;
}

function descriptorFor({ invocation, resolved, environment, stdin, transfers, protectedValues, messages, entryLocation, scratchRoot }) {
  if (!resolved || typeof resolved.program !== 'string' || !SAFE_NAME.test(resolved.program)) throw new Error(messages.program);
  const fixed = resolved.arguments ?? [];
  if (!Array.isArray(fixed) || fixed.some((entry) => typeof entry !== 'string')) throw new Error(messages.arguments);
  const locations = [];
  const locationIndex = new Map();
  const locate = (kind, name) => {
    const key = `${kind}:${name}`;
    if (!locationIndex.has(key)) {
      const location = kind === 'scratch'
        ? { class: 'scratch', path: `${scratchRoot}/${name}` }
        : { class: kind, path: `ports/${name}` };
      if (kind === 'scratch' && typeof scratchRoot !== 'string') throw new Error(messages.scratchRoot);
      locationIndex.set(key, locations.length);
      locations.push(location);
    }
    return locationIndex.get(key);
  };
  const argumentsList = [];
  if (entryLocation) {
    locations.push(entryLocation);
    argumentsList.push({ kind: 'location', index: 0 });
  }
  argumentsList.push(...fixed.map((value) => ({ kind: 'literal', value })));
  for (const argument of invocation.arguments) {
    if (argument.kind === 'literal') argumentsList.push({ kind: 'literal', value: argument.value });
    else argumentsList.push({ kind: 'location', index: locate(argument.kind, argument.name) });
  }
  const known = new Set(transfers.map((entry) => `${entry.direction}:${entry.name}`));
  for (const argument of invocation.arguments) {
    if (argument.kind === 'literal' || argument.kind === 'scratch') continue;
    if (!known.has(`${argument.kind}:${argument.name}`)) throw new Error(messages.transfer);
  }
  for (const value of Object.values(environment)) {
    if (protectedValues.some((protectedValue) => value.includes(protectedValue))) {
      throw new Error(messages.protectedValue);
    }
  }
  return {
    descriptor: {
      protocol: 'devbridge/work-operation-v1',
      program: resolved.program,
      arguments: argumentsList,
      environment,
      stdin,
    },
    locations,
  };
}

export class OperationMaterializer {
  #write;
  #protectedValues;
  #scratchRoot;
  #messages;

  constructor({ write, protectedValues, scratchRoot, messages = {} }) {
    this.#write = write;
    this.#protectedValues = [...protectedValues];
    this.#scratchRoot = scratchRoot;
    this.#messages = {
      program: messages.program ?? 'operation definition did not resolve to a safe local program',
      arguments: messages.arguments ?? 'operation definition fixed arguments are invalid',
      scratchRoot: messages.scratchRoot ?? 'operation scratch root is unavailable',
      transfer: messages.transfer ?? 'operation argument transfer is not registered',
      protectedValue: messages.protectedValue ?? 'operation contains a protected value',
      resourcePath: messages.resourcePath ?? 'resource path is invalid',
      normalizedResourcePath: messages.normalizedResourcePath ?? 'resource path is not normalized',
      resources: messages.resources ?? 'resources are invalid',
      entryRequiresResources: messages.entryRequiresResources ?? 'entry requires resources',
      resource: messages.resource ?? 'resource is invalid',
      duplicateResource: messages.duplicateResource ?? 'resource path is duplicated',
      resourceLimit: messages.resourceLimit ?? 'resources exceed their bound',
      missingEntry: messages.missingEntry ?? 'entry is not present in resources',
      descriptorLimit: messages.descriptorLimit ?? 'descriptor exceeds its bounded staging limit',
    };
  }

  async #stageResources(resolved) {
    const resources = resolved?.resources ?? [];
    if (!Array.isArray(resources) || resources.length > RESOURCE_COUNT) throw new Error(this.#messages.resources);
    if (resources.length === 0) {
      if (resolved?.entry != null) throw new Error(this.#messages.entryRequiresResources);
      return null;
    }
    const normalized = [];
    const paths = new Set();
    let total = 0;
    const digest = createHash('sha256');
    for (const raw of resources) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Buffer.isBuffer(raw.bytes)) throw new Error(this.#messages.resource);
      const name = resourcePath(raw.path, this.#messages);
      if (paths.has(name)) throw new Error(this.#messages.duplicateResource);
      paths.add(name);
      const bytes = Buffer.from(raw.bytes);
      total += bytes.length;
      if (total > RESOURCE_LIMIT) throw new Error(this.#messages.resourceLimit);
      digest.update(name, 'utf8').update('\0').update(bytes).update('\0');
      normalized.push({ name, bytes });
    }
    const entry = resourcePath(resolved.entry, this.#messages);
    if (!paths.has(entry)) throw new Error(this.#messages.missingEntry);
    const root = `tools/${digest.digest('hex').slice(0, 32)}`;
    for (const resource of normalized) {
      await this.#write(resource.bytes, { class: 'input', path: `${root}/${resource.name}` });
    }
    return { class: 'input', path: `${root}/${entry}` };
  }

  async stage({ invocation, resolved, environment, stdin, transfers }) {
    const entryLocation = await this.#stageResources(resolved);
    const materialized = descriptorFor({
      invocation,
      resolved,
      environment,
      stdin,
      transfers,
      protectedValues: this.#protectedValues,
      messages: this.#messages,
      entryLocation,
      scratchRoot: this.#scratchRoot,
    });
    const bytes = Buffer.from(`${JSON.stringify(materialized.descriptor)}\n`, 'utf8');
    if (bytes.length > DESCRIPTOR_LIMIT) throw new Error(this.#messages.descriptorLimit);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const location = { class: 'input', path: `control/operation-${digest}.json` };
    await this.#write(bytes, location);
    return { location, arguments: materialized.locations };
  }
}
