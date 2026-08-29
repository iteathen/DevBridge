import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const MINIMUM_NODE = Object.freeze([22, 16, 0]);
const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u;

function fail(message) { throw new Error(message); }

export function assertSupportedNode(version = process.versions.node) {
  const parts = String(version).split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length < 3 || parts.some((value) => !Number.isInteger(value))) {
    fail(`Could not parse Node.js version: ${version}`);
  }
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return;
    if (parts[index] < MINIMUM_NODE[index]) fail('DevBridge requires Node.js 22.16.0 or newer.');
  }
}

function expandPath(value, homeDirectory) {
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDirectory, value.slice(2));
  return value;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || !value || value.startsWith('-')) fail(`${flag} requires a value`);
  return value;
}

export function isExactHead(value) {
  return EXACT_HEAD.test(String(value ?? '').toLowerCase());
}

export function normalizeInstallRef(value) {
  const ref = String(value ?? '');
  const exact = ref.toLowerCase();
  if (EXACT_HEAD.test(exact)) return Object.freeze({ kind: 'exact', value: exact });
  const segments = ref.split('/');
  if (!SAFE_REF.test(ref) || ref.startsWith('-') || ref.includes('\\') || ref.endsWith('/') || ref.endsWith('.lock') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('Install ref is invalid.');
  }
  return Object.freeze({ kind: 'branch', value: ref });
}

export function parseInstallArgs(argv, { environment = process.env, homeDirectory = homedir() } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('installer argv must be an array');
  let home = environment.DEVBRIDGE_HOME ?? path.join(homeDirectory, '.devbridge');
  let selector = null;
  let help = false;
  let runSetup = true;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') { help = true; continue; }
    if (value === '--install-only') { runSetup = false; continue; }
    if (value === '--home') {
      home = takeValue(argv, index, value);
      index += 1;
      continue;
    }
    if (value === '--ref' || value === '--branch') {
      if (selector != null) fail('Only one installer ref/branch selector may be supplied.');
      selector = normalizeInstallRef(takeValue(argv, index, value));
      index += 1;
      continue;
    }
    fail(`Unsupported installer argument: ${value}`);
  }
  return Object.freeze({
    help,
    home: path.resolve(expandPath(String(home), homeDirectory)),
    selector: selector ?? Object.freeze({ kind: 'branch', value: 'main' }),
    selectedRunnerRef: selector?.value ?? null,
    runSetup,
  });
}
