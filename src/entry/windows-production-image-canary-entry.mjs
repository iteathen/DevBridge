#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createWindowsProductionImagePhysicalCanary } from '../app/windows-production-image-physical-canary.js';

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || !['status', 'run'].includes(argv[0]) || argv[1] !== '--config') {
    throw new Error('usage: windows-production-image-canary-entry.mjs <status|run> --config <absolute-local-config>');
  }
  const location = argv[2];
  if (typeof location !== 'string' || location.length === 0 || location.includes('\0') || !path.isAbsolute(location)) throw new Error('physical canary config path must be absolute');
  return Object.freeze({ action: argv[0], config: path.resolve(location) });
}

async function loadConfig(location) {
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_CONFIG_BYTES) throw new Error('physical canary config must be a bounded real file');
  let value;
  try { value = JSON.parse(await readFile(location, 'utf8')); }
  catch (error) { throw new Error(`physical canary config is not valid JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('physical canary config must contain one object');
  return value;
}

export async function runWindowsProductionImageCanaryEntry(argv, {
  factory = createWindowsProductionImagePhysicalCanary,
  stdout = process.stdout,
} = {}) {
  if (typeof factory !== 'function') throw new TypeError('physical canary entry factory is invalid');
  if (!stdout || typeof stdout.write !== 'function') throw new TypeError('physical canary entry output is invalid');
  const selected = parseArguments(argv);
  const canary = factory(await loadConfig(selected.config));
  if (!canary || typeof canary.status !== 'function' || typeof canary.run !== 'function') throw new TypeError('physical canary entry contract is incomplete');
  const result = selected.action === 'status' ? await canary.status() : await canary.run();
  stdout.write(`${JSON.stringify(result)}\n`);
  return result?.blocked === true ? 2 : 0;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try { process.exitCode = await runWindowsProductionImageCanaryEntry(process.argv.slice(2)); }
  catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
