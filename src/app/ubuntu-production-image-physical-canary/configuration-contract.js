import path from 'node:path';

function onlyKeys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute local path`);
  return path.resolve(value);
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

export function createConfigurationContract({ protocol, selectionField, normalizeSelection, limits, layout }) {
  if (typeof protocol !== 'string' || protocol.length === 0) throw new TypeError('configuration protocol is invalid');
  if (typeof selectionField !== 'string' || selectionField.length === 0) throw new TypeError('configuration selection field is invalid');
  if (typeof normalizeSelection !== 'function') throw new TypeError('configuration selection normalizer is invalid');
  const selectedLimits = onlyKeys(limits, new Set(['minimumMemoryBytes', 'maximumMemoryBytes', 'minimumDiskBytes', 'maximumDiskBytes', 'maximumProcessors']), 'configuration limits');
  const limitNames = ['minimumMemoryBytes', 'maximumMemoryBytes', 'minimumDiskBytes', 'maximumDiskBytes', 'maximumProcessors'];
  for (const name of limitNames) {
    if (!Number.isSafeInteger(selectedLimits[name]) || selectedLimits[name] < 1) throw new TypeError(`configuration limits.${name} is invalid`);
  }
  if (selectedLimits.minimumMemoryBytes > selectedLimits.maximumMemoryBytes || selectedLimits.minimumDiskBytes > selectedLimits.maximumDiskBytes) throw new TypeError('configuration limits are inconsistent');
  const layoutNames = ['root', 'lease', 'selection', 'progress', 'preparation', 'sourceRoot', 'cache', 'source', 'prepared', 'operation', 'output', 'access', 'foundation'];
  const selectedLayout = onlyKeys(layout, new Set(layoutNames), 'configuration layout');
  for (const name of layoutNames) {
    const value = selectedLayout[name];
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || path.isAbsolute(value) || path.basename(value) !== value || ['.', '..'].includes(value)) throw new TypeError(`configuration layout.${name} is invalid`);
  }

  const normalize = (raw) => {
    const value = onlyKeys(raw, new Set(['protocol', 'stateDirectory', 'keyring', selectionField, 'resources']), 'physical canary config');
    if (value.protocol !== protocol) throw new TypeError('physical canary config protocol is unsupported');
    const resources = onlyKeys(value.resources, new Set(['memoryBytes', 'processorCount', 'diskBytes']), 'physical canary resources');
    return Object.freeze({
      protocol,
      stateDirectory: absolutePath(value.stateDirectory, 'physical canary stateDirectory'),
      keyring: absolutePath(value.keyring, 'physical canary keyring'),
      selection: normalizeSelection(value[selectionField]),
      resources: Object.freeze({
        memoryBytes: boundedInteger(resources.memoryBytes, selectedLimits.minimumMemoryBytes, selectedLimits.maximumMemoryBytes, 'physical canary resources.memoryBytes'),
        processorCount: boundedInteger(resources.processorCount, 1, selectedLimits.maximumProcessors, 'physical canary resources.processorCount'),
        diskBytes: boundedInteger(resources.diskBytes, selectedLimits.minimumDiskBytes, selectedLimits.maximumDiskBytes, 'physical canary resources.diskBytes'),
      }),
    });
  };

  const derivePaths = (config, identity) => {
    if (typeof identity !== 'string' || identity.length === 0 || identity.includes('\0') || Buffer.byteLength(identity, 'utf8') > 240 || path.basename(identity) !== identity || ['.', '..'].includes(identity)) throw new TypeError('configuration identity is invalid');
    const root = path.join(config.stateDirectory, selectedLayout.root);
    const sourceRoot = path.join(root, selectedLayout.sourceRoot);
    const subjectRoot = path.join(sourceRoot, identity);
    return Object.freeze({
      root,
      lease: path.join(root, selectedLayout.lease),
      selection: path.join(root, selectedLayout.selection),
      progress: path.join(root, selectedLayout.progress),
      preparation: path.join(root, selectedLayout.preparation),
      sourceRoot,
      subjectRoot,
      cache: path.join(root, selectedLayout.cache),
      source: path.join(subjectRoot, selectedLayout.source),
      prepared: path.join(subjectRoot, selectedLayout.prepared),
      operation: path.join(root, selectedLayout.operation),
      output: path.join(root, selectedLayout.output),
      access: path.join(root, selectedLayout.access),
      foundation: path.join(config.stateDirectory, selectedLayout.foundation),
    });
  };

  return Object.freeze({ normalize, derivePaths });
}
