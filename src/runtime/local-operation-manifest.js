import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';
import { normalizePlanPath } from '../run/controller-plan.js';
import { resolveExecutable } from './executable-resolver.js';

export const LOCAL_OPERATION_MANIFEST_PROTOCOL = 'patch-poller/local-operation-manifest-v1';
export const OPERATION_PARAMETER_SCHEMA_PROTOCOL = 'patch-poller/operation-parameters-v1';

const SAFE_ID = /^[A-Za-z0-9_.-]{1,80}$/u;
const SAFE_COMMAND = /^[A-Za-z0-9_.+-]{1,80}$/u;
const SAFE_FLAG = /^--[A-Za-z0-9][A-Za-z0-9-]{0,79}$/u;
const SAFE_PARAM = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const SAFE_LITERAL = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFESTS = 64;
const MAX_ARGUMENTS = 64;
const MAX_ENUM_VALUES = 64;
const VALUE_TYPES = new Set(['string', 'project-path', 'integer', 'enum']);
const FORBIDDEN_PARAMETER_NAMES = new Set([
  'command', 'shell', 'argv', 'args', 'executable', 'cwd', 'localpath', 'absolutepath',
  'environment', 'env', 'credentials', 'credential', 'capabilities', 'gitref', 'gitsha',
  'cleanuproot', 'module', 'plugin', 'faultinjection', 'exec', 'eval', 'require', 'chdir',
]);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyError(`${name} must be an object`);
  return value;
}

function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new PolicyError(`${name}.${key} is not allowed`);
}

function safeIdentifier(value, name, pattern = SAFE_ID) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new PolicyError(`${name} is invalid`);
  return value;
}

function safeParameter(value, name) {
  const param = safeIdentifier(value, name, SAFE_PARAM);
  const authorityKey = param.toLowerCase().replace(/[_-]/gu, '');
  if (FORBIDDEN_PARAMETER_NAMES.has(authorityKey)) throw new PolicyError(`${name} is reserved for control-plane authority`);
  return param;
}

function safeInteger(value, name, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new PolicyError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function validateExecutable(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) {
    throw new PolicyError('local operation manifest executable is invalid');
  }
  if (!path.isAbsolute(value) && !SAFE_COMMAND.test(value)) {
    throw new PolicyError('local operation manifest executable must be an absolute local path or safe command name');
  }
  return value;
}

function validateValueDescriptor(raw, name) {
  const valueType = raw.valueType ?? 'string';
  if (!VALUE_TYPES.has(valueType)) throw new PolicyError(`${name}.valueType is unsupported`);
  const descriptor = { valueType };
  if (valueType === 'enum') {
    if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.length > MAX_ENUM_VALUES) {
      throw new PolicyError(`${name}.values must contain 1-${MAX_ENUM_VALUES} entries`);
    }
    const values = [];
    const seen = new Set();
    for (const [index, value] of raw.values.entries()) {
      if (typeof value !== 'string' || !SAFE_LITERAL.test(value) || value.startsWith('-')) {
        throw new PolicyError(`${name}.values[${index}] is invalid`);
      }
      if (!seen.has(value)) values.push(value);
      seen.add(value);
    }
    descriptor.values = values;
  } else if (raw.values != null) {
    throw new PolicyError(`${name}.values is only valid for enum arguments`);
  }
  return descriptor;
}

function validateArgument(raw, index) {
  const name = `local operation manifest arguments[${index}]`;
  const value = requireObject(raw, name);
  const kind = value.kind;
  if (!['literal', 'flag', 'option', 'positional'].includes(kind)) throw new PolicyError(`${name}.kind is unsupported`);

  if (kind === 'literal') {
    onlyKeys(value, new Set(['kind', 'value']), name);
    if (typeof value.value !== 'string' || !SAFE_LITERAL.test(value.value)) throw new PolicyError(`${name}.value is invalid`);
    return { kind, value: value.value };
  }

  if (kind === 'flag') {
    onlyKeys(value, new Set(['kind', 'param', 'flag']), name);
    return {
      kind,
      param: safeParameter(value.param, `${name}.param`),
      flag: safeIdentifier(value.flag, `${name}.flag`, SAFE_FLAG),
    };
  }

  const allowed = new Set(['kind', 'param', 'required', 'repeat', 'maxItems', 'valueType', 'values']);
  if (kind === 'option') allowed.add('flag');
  onlyKeys(value, allowed, name);
  const result = {
    kind,
    param: safeParameter(value.param, `${name}.param`),
    required: value.required === true,
    repeat: value.repeat === true,
    ...validateValueDescriptor(value, name),
  };
  if (kind === 'option') result.flag = safeIdentifier(value.flag, `${name}.flag`, SAFE_FLAG);
  if (result.repeat) result.maxItems = safeInteger(value.maxItems ?? 16, `${name}.maxItems`, { min: 1, max: 32 });
  else if (value.maxItems != null) throw new PolicyError(`${name}.maxItems requires repeat=true`);
  return result;
}

export function validateLocalOperationManifest(raw) {
  const manifest = requireObject(raw, 'local operation manifest');
  onlyKeys(manifest, new Set([
    'protocol', 'operation', 'executable', 'arguments', 'timeoutMs', 'maxOutputBytes',
    'requireAnyParameter', 'source',
  ]), 'local operation manifest');
  if (manifest.protocol !== LOCAL_OPERATION_MANIFEST_PROTOCOL) throw new PolicyError('local operation manifest protocol is unsupported');
  const operation = safeIdentifier(manifest.operation, 'local operation manifest operation');
  if (!operation.startsWith('tool.')) throw new PolicyError('local dynamic operation names must use the tool. prefix');
  const executable = validateExecutable(manifest.executable);
  if (!Array.isArray(manifest.arguments) || manifest.arguments.length > MAX_ARGUMENTS) {
    throw new PolicyError(`local operation manifest arguments must contain at most ${MAX_ARGUMENTS} entries`);
  }
  const args = manifest.arguments.map(validateArgument);
  const params = new Set();
  for (const arg of args) {
    if (!arg.param) continue;
    if (params.has(arg.param)) throw new PolicyError(`local operation manifest duplicates parameter ${arg.param}`);
    params.add(arg.param);
  }

  const source = manifest.source == null ? { kind: 'operator' } : requireObject(manifest.source, 'local operation manifest source');
  onlyKeys(source, new Set(['kind', 'command', 'helpSha256']), 'local operation manifest source');
  if (!['operator', 'help-synthesized'].includes(source.kind)) throw new PolicyError('local operation manifest source.kind is invalid');
  const normalizedSource = { kind: source.kind };
  if (source.kind === 'help-synthesized') {
    normalizedSource.command = safeIdentifier(source.command, 'local operation manifest source.command', SAFE_COMMAND);
    if (typeof source.helpSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(source.helpSha256)) {
      throw new PolicyError('local operation manifest source.helpSha256 must be a lowercase SHA-256 digest');
    }
    normalizedSource.helpSha256 = source.helpSha256;
  } else if (source.command != null || source.helpSha256 != null) {
    throw new PolicyError('operator local operation manifests must not claim synthesized source evidence');
  }

  return {
    protocol: LOCAL_OPERATION_MANIFEST_PROTOCOL,
    operation,
    executable,
    arguments: args,
    timeoutMs: safeInteger(manifest.timeoutMs ?? 120_000, 'local operation manifest timeoutMs', { min: 1_000, max: 900_000 }),
    maxOutputBytes: safeInteger(manifest.maxOutputBytes ?? 1024 * 1024, 'local operation manifest maxOutputBytes', { min: 1_024, max: 4 * 1024 * 1024 }),
    requireAnyParameter: manifest.requireAnyParameter === true,
    source: normalizedSource,
  };
}

function publicSchemaForManifest(normalized) {
  return {
    protocol: OPERATION_PARAMETER_SCHEMA_PROTOCOL,
    requireAnyParameter: normalized.requireAnyParameter === true,
    parameters: normalized.arguments
      .filter((entry) => entry.param)
      .map((entry) => {
        if (entry.kind === 'flag') {
          return {
            name: entry.param,
            kind: 'flag',
            valueType: 'boolean',
            required: false,
            repeat: false,
          };
        }
        const parameter = {
          name: entry.param,
          kind: entry.kind,
          valueType: entry.valueType,
          required: entry.required === true,
          repeat: entry.repeat === true,
        };
        if (entry.repeat) parameter.maxItems = entry.maxItems;
        if (entry.valueType === 'enum') parameter.values = [...entry.values];
        return parameter;
      }),
  };
}

function boundedScalar(value, name) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PolicyError(`${name} must be a bounded non-control string`);
  }
  if (value.startsWith('-')) throw new PolicyError(`${name} must not begin with '-'`);
  const portable = value.replace(/\\/gu, '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//u.test(portable) || portable.startsWith('//')) {
    throw new PolicyError(`${name} must not be an absolute path-shaped value`);
  }
  if (portable.split('/').includes('..')) throw new PolicyError(`${name} must not contain traversal segments`);
  return value;
}

function encodeValue(descriptor, value, name) {
  if (descriptor.valueType === 'integer') {
    if (!Number.isSafeInteger(value)) throw new PolicyError(`${name} must be a safe integer`);
    return String(value);
  }
  if (descriptor.valueType === 'enum') {
    if (typeof value !== 'string' || !descriptor.values.includes(value)) throw new PolicyError(`${name} is not an allowed enum value`);
    return value;
  }
  if (descriptor.valueType === 'project-path') return normalizePlanPath(value, name);
  return boundedScalar(value, name);
}

function materializeArgument(descriptor, raw, name) {
  if (!descriptor.repeat) return encodeValue(descriptor, raw, name);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > descriptor.maxItems) {
    throw new PolicyError(`${name} must contain 1-${descriptor.maxItems} values`);
  }
  return raw.map((value, index) => encodeValue(descriptor, value, `${name}[${index}]`));
}

function localEnvironment() {
  const pass = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SystemDrive']
    : ['PATH'];
  return { pass, set: { CI: '1' } };
}

export function createManifestOperationAdapter(manifest, { env = process.env } = {}) {
  const normalized = validateLocalOperationManifest(manifest);
  const descriptors = new Map(normalized.arguments.filter((entry) => entry.param).map((entry) => [entry.param, entry]));
  return {
    layer: 'local-manifest',
    manifest: normalized,
    publicSchema: publicSchemaForManifest(normalized),
    validate(raw) {
      const params = raw == null ? {} : requireObject(raw, `${normalized.operation} params`);
      for (const key of Object.keys(params)) if (!descriptors.has(key)) throw new PolicyError(`${normalized.operation} parameter ${key} is not allowed`);
      let supplied = 0;
      const result = {};
      for (const [param, descriptor] of descriptors) {
        const present = Object.hasOwn(params, param);
        if (descriptor.kind === 'flag') {
          if (!present) continue;
          if (typeof params[param] !== 'boolean') throw new PolicyError(`${normalized.operation}.${param} must be boolean`);
          result[param] = params[param];
          if (params[param]) supplied += 1;
          continue;
        }
        if (!present) {
          if (descriptor.required) throw new PolicyError(`${normalized.operation}.${param} is required`);
          continue;
        }
        result[param] = materializeArgument(descriptor, params[param], `${normalized.operation}.${param}`);
        supplied += 1;
      }
      if (normalized.requireAnyParameter && supplied === 0) throw new PolicyError(`${normalized.operation} requires at least one bounded parameter`);
      return result;
    },
    async execute(params, { projectDir, processRunner, onActivity }) {
      const executable = await resolveExecutable(normalized.executable, env);
      const args = [];
      for (const descriptor of normalized.arguments) {
        if (descriptor.kind === 'literal') {
          args.push(descriptor.value);
          continue;
        }
        if (!Object.hasOwn(params, descriptor.param)) continue;
        if (descriptor.kind === 'flag') {
          if (params[descriptor.param]) args.push(descriptor.flag);
          continue;
        }
        const values = descriptor.repeat ? params[descriptor.param] : [params[descriptor.param]];
        for (const value of values) {
          if (descriptor.kind === 'option') args.push(descriptor.flag, value);
          else args.push(value);
        }
      }
      return processRunner.run({
        executable,
        args,
        cwd: projectDir,
        timeoutMs: normalized.timeoutMs,
        maxOutputBytes: normalized.maxOutputBytes,
        environment: localEnvironment(),
        onActivity,
        operation: normalized.operation,
        sandbox: {
          required: true,
          projectDir,
          network: 'deny',
          exposeConfiguredReadRoots: false,
        },
      });
    },
  };
}

async function canonicalManifestDirectory(directory) {
  const resolved = path.resolve(directory);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new PolicyError('local operation manifest directory must be a real directory');
  let current = path.dirname(resolved);
  while (true) {
    const parentInfo = await lstat(current);
    if (parentInfo.isSymbolicLink()) throw new PolicyError('local operation manifest directory must not use filesystem indirection');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpath(resolved);
}

export async function loadLocalOperationManifests({ directory, registry, env = process.env }) {
  if (!directory) return [];
  if (!registry || typeof registry.register !== 'function') throw new TypeError('loadLocalOperationManifests requires an operation registry');
  const root = await canonicalManifestDirectory(directory);
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (entries.length > MAX_MANIFESTS) throw new PolicyError(`local operation manifest directory exceeds ${MAX_MANIFESTS} JSON files`);
  const loaded = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new PolicyError(`local operation manifest ${entry.name} must be a regular file`);
    const filePath = path.join(root, entry.name);
    const info = await lstat(filePath);
    if (info.size > MAX_MANIFEST_BYTES) throw new PolicyError(`local operation manifest ${entry.name} exceeds ${MAX_MANIFEST_BYTES} bytes`);
    const canonical = await realpath(filePath);
    if (path.dirname(canonical) !== root) throw new PolicyError(`local operation manifest ${entry.name} escapes the configured directory`);
    let raw;
    try { raw = JSON.parse(await readFile(canonical, 'utf8')); }
    catch (error) { throw new PolicyError(`local operation manifest ${entry.name} is invalid JSON`, { cause: error }); }
    const manifest = validateLocalOperationManifest(raw);
    registry.register(manifest.operation, createManifestOperationAdapter(manifest, { env }));
    loaded.push({ operation: manifest.operation, source: manifest.source.kind, file: entry.name });
  }
  return loaded;
}
