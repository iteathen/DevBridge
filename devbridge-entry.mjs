#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  bootstrapStage0,
  parseStage0Args,
  resolveStage0Paths,
  selectStage0Runtime,
} from './devbridge.mjs';

const SELECTED_ENTRY_FLAGS = new Set(['--ref', '--branch']);

function fail(message) { throw new Error(message); }

function requireEntry(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

export function hasSelectedEntrySelector(argv) {
  if (!Array.isArray(argv)) throw new TypeError('installed-entry argv must be an array');
  let selected = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!SELECTED_ENTRY_FLAGS.has(flag)) continue;
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('-')) fail(`${flag} requires a local selector value`);
    if (selected) fail('Only one installed-entry selector may be supplied.');
    selected = true;
    index += 1;
  }
  return selected;
}

export async function loadSelectedEntry(argv, {
  runtimeSelector = (paths) => selectStage0Runtime(paths),
  importModuleFn = (url) => import(url),
} = {}) {
  requireEntry(runtimeSelector, 'runtimeSelector');
  requireEntry(importModuleFn, 'importModuleFn');
  const args = parseStage0Args(argv);
  const paths = resolveStage0Paths(args);
  const selection = await runtimeSelector(paths);
  const runtimeDir = selection?.runtime?.runtimeDir;
  if (typeof runtimeDir !== 'string' || !path.isAbsolute(runtimeDir)) {
    fail('Accepted DevBridge runtime does not identify one absolute selected-entry root.');
  }
  const adapterUrl = pathToFileURL(path.join(runtimeDir, 'src', 'entry', 'selected-entry.mjs')).href;
  let module;
  try {
    module = await importModuleFn(adapterUrl);
  } catch {
    fail('Accepted DevBridge runtime does not provide a usable selected-entry adapter.');
  }
  return requireEntry(module?.runSelectedEntry, 'selected-entry adapter');
}

export async function runInstalledEntry(argv = process.argv.slice(2), {
  defaultEntry = bootstrapStage0,
  selectedEntryLoader = loadSelectedEntry,
} = {}) {
  requireEntry(defaultEntry, 'defaultEntry');
  requireEntry(selectedEntryLoader, 'selectedEntryLoader');
  const input = [...argv];
  if (!hasSelectedEntrySelector(input)) return defaultEntry(input);
  const selectedEntry = requireEntry(await selectedEntryLoader(input), 'selectedEntry');
  return selectedEntry([...input]);
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const status = await runInstalledEntry();
    if (Number.isInteger(status)) process.exitCode = status;
  } catch (error) {
    process.stderr.write(`[devbridge-entry] ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
