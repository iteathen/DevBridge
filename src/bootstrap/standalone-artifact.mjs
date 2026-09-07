const DATA_IMPORT = 'data:text/javascript;base64,';
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|(?:^|\n)\s*import\s*)['"]([^'"]+)['"]/gu;
const MAX_MODULES = 512;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function fail(message) { throw new Error(message); }

function exactObject(raw, allowed, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  return raw;
}

function logicalIdentity(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || value.startsWith('/')
      || value.includes('\\') || value.includes('\0') || value.includes(':')) {
    throw new TypeError(`${name} is invalid`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'
      || /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function sourceRecord(raw, name) {
  const value = exactObject(raw, new Set(['identity', 'bytes']), name);
  const identity = logicalIdentity(value.identity, `${name}.identity`);
  let bytes;
  if (typeof value.bytes === 'string') bytes = Buffer.from(value.bytes, 'utf8');
  else if (Buffer.isBuffer(value.bytes) || value.bytes instanceof Uint8Array) bytes = Buffer.from(value.bytes);
  else throw new TypeError(`${name}.bytes must be source bytes`);
  if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) throw new TypeError(`${name}.bytes exceeds its bound`);
  const text = bytes.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) throw new TypeError(`${name}.bytes must be exact UTF-8 text`);
  return Object.freeze({ identity, bytes, source: text.replace(/\r\n/gu, '\n') });
}

function provenanceLine(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
      || value.includes('\n') || value.includes('\r') || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('standalone provenance must be one bounded line');
  }
  return value;
}

function importRecords(source) {
  return [...source.matchAll(MODULE_SPECIFIER)].map((match) => {
    const specifier = match[1];
    const offset = match[0].lastIndexOf(specifier);
    return Object.freeze({ specifier, start: match.index + offset, end: match.index + offset + specifier.length });
  });
}

function importClass(specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return 'local';
  if (specifier.startsWith('node:')) return 'builtin';
  if (specifier.startsWith(DATA_IMPORT)) return 'embedded';
  return 'unsupported';
}

function localEdges(record) {
  const edges = [];
  const seen = new Set();
  for (const entry of importRecords(record.source)) {
    const kind = importClass(entry.specifier);
    if (kind === 'unsupported') fail(`standalone module ${record.identity} contains unsupported import ${entry.specifier}`);
    if (kind !== 'local') continue;
    if (entry.specifier.includes('?') || entry.specifier.includes('#')
        || !/\.[A-Za-z0-9]+$/u.test(entry.specifier)) {
      fail(`standalone module ${record.identity} contains an invalid relative import ${entry.specifier}`);
    }
    if (seen.has(entry.specifier)) fail(`standalone module ${record.identity} contains a duplicate local import ${entry.specifier}`);
    seen.add(entry.specifier);
    edges.push(entry);
  }
  return edges;
}

function rewrite(source, replacements) {
  let output = source;
  for (const entry of [...replacements].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, entry.start)}${entry.value}${output.slice(entry.end)}`;
  }
  return output;
}

export function compileStandaloneArtifact({ entry: rawEntry, load, provenance } = {}) {
  if (typeof load !== 'function') throw new TypeError('standalone local-edge loader must be a function');
  const selectedProvenance = provenanceLine(provenance);
  const entry = sourceRecord(rawEntry, 'standalone entry');
  const observed = new Map([[entry.identity, entry]]);
  const compiled = new Map();
  const active = new Set();

  function compile(record) {
    if (compiled.has(record.identity)) return compiled.get(record.identity);
    if (active.has(record.identity)) fail(`standalone module graph contains a cycle at ${record.identity}`);
    active.add(record.identity);
    try {
      const replacements = [];
      for (const edge of localEdges(record)) {
        const loaded = sourceRecord(load(Object.freeze({ importer: record.identity, specifier: edge.specifier })), 'standalone dependency');
        const prior = observed.get(loaded.identity);
        if (prior && !prior.bytes.equals(loaded.bytes)) fail(`standalone module identity ${loaded.identity} returned conflicting bytes`);
        if (!prior) {
          if (observed.size >= MAX_MODULES) fail('standalone module graph exceeds its module bound');
          observed.set(loaded.identity, loaded);
        }
        const dependency = prior ?? loaded;
        const child = compile(dependency);
        const value = `${DATA_IMPORT}${Buffer.from(child, 'utf8').toString('base64')}`;
        replacements.push(Object.freeze({ ...edge, value }));
      }
      const output = rewrite(record.source, replacements);
      if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) fail('standalone module graph exceeds its output bound');
      if (localEdges(Object.freeze({ identity: record.identity, source: output })).length !== 0) {
        fail(`standalone module ${record.identity} retains a local import`);
      }
      compiled.set(record.identity, output);
      return output;
    } finally {
      active.delete(record.identity);
    }
  }

  let output = compile(entry);
  const header = `// Generated from ${selectedProvenance}; edit modular sources and regenerate.\n`;
  if (output.startsWith('#!')) {
    const newline = output.indexOf('\n');
    if (newline < 0) fail('standalone entry shebang is incomplete');
    output = `${output.slice(0, newline + 1)}${header}${output.slice(newline + 1)}`;
  } else {
    output = `${header}${output}`;
  }
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) fail('standalone artifact exceeds its output bound');
  return Buffer.from(output.endsWith('\n') ? output : `${output}\n`, 'utf8');
}
