const DATA_IMPORT = 'data:text/javascript;base64,';
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|(?:^|\n)\s*import\s*)['"]([^'"]+)['"]/gu;

function fail(message) { throw new Error(message); }

function normalizedText(value, name) {
  if (typeof value !== 'string' || value.length < 1) fail(`${name} must be non-empty text`);
  return value.replace(/\r\n/gu, '\n');
}

function localSpecifiers(source) {
  const result = [];
  for (const match of source.matchAll(MODULE_SPECIFIER)) {
    const value = match[1];
    if (value.startsWith('./') || value.startsWith('../')) result.push(value);
  }
  return result;
}

function validateEmbeddedSource(source, specifier) {
  for (const match of source.matchAll(MODULE_SPECIFIER)) {
    const value = match[1];
    if (!value.startsWith('node:') && !value.startsWith(DATA_IMPORT)) {
      fail(`embedded module ${specifier} contains unsupported import ${value}`);
    }
  }
}

function replaceOne(source, specifier, replacement) {
  const single = `'${specifier}'`;
  const double = `"${specifier}"`;
  const singleCount = source.split(single).length - 1;
  const doubleCount = source.split(double).length - 1;
  if (singleCount + doubleCount !== 1) {
    fail(`standalone source must import ${specifier} exactly once`);
  }
  if (singleCount === 1) return source.replace(single, `'${replacement}'`);
  return source.replace(double, `"${replacement}"`);
}

export function compileStandaloneArtifact({ source, modules, provenance }) {
  let output = normalizedText(source, 'standalone source');
  if (!Array.isArray(modules) || modules.length < 1) fail('standalone modules must be a non-empty array');
  if (typeof provenance !== 'string' || provenance.length < 1 || provenance.includes('\n') || provenance.includes('\r')) {
    fail('standalone provenance must be one bounded line');
  }

  const expected = localSpecifiers(output);
  if (new Set(expected).size !== expected.length) fail('standalone source contains duplicate local imports');
  if (expected.length !== modules.length) fail('standalone module set does not match local imports');

  const supplied = new Map();
  for (const entry of modules) {
    if (typeof entry?.specifier !== 'string' || !expected.includes(entry.specifier) || supplied.has(entry.specifier)) {
      fail('standalone module set contains an unexpected or duplicate specifier');
    }
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes ?? '');
    if (bytes.length < 1) fail(`embedded module ${entry.specifier} is empty`);
    const child = normalizedText(bytes.toString('utf8'), `embedded module ${entry.specifier}`);
    validateEmbeddedSource(child, entry.specifier);
    supplied.set(entry.specifier, `${DATA_IMPORT}${Buffer.from(child, 'utf8').toString('base64')}`);
  }

  for (const specifier of expected) {
    const replacement = supplied.get(specifier);
    if (replacement == null) fail(`standalone module ${specifier} is missing`);
    output = replaceOne(output, specifier, replacement);
  }
  if (localSpecifiers(output).length !== 0) fail('standalone artifact retains a local import');

  const header = `// Generated from ${provenance}; edit modular sources and regenerate.\n`;
  if (output.startsWith('#!')) {
    const newline = output.indexOf('\n');
    output = `${output.slice(0, newline + 1)}${header}${output.slice(newline + 1)}`;
  } else {
    output = `${header}${output}`;
  }
  return Buffer.from(output.endsWith('\n') ? output : `${output}\n`, 'utf8');
}
