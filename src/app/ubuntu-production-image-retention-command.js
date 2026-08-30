import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ubuntuConstructionAuthoritySubject } from '../runtime/image-builders/ubuntu-construction-authority.js';
import { deriveCurrentUbuntuSetupAuthority } from '../setup/ubuntu-authority.js';
import { JsonStateStore } from '../state/json-state-store.js';
import { createUbuntuConstructionAuthorityStateStore } from '../state/ubuntu-construction-authority-state-store.js';
import { createUbuntuProductionImageRetention } from './ubuntu-production-image-retention.js';

const SUBJECT = /^subject-[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SETUP_KEY = 'setup:v1';

function option(argv, index, name) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error(`${name} requires one value`);
  return value;
}

function parseArguments(raw) {
  if (!Array.isArray(raw) || raw.length > 7) throw new TypeError('construction retention arguments are invalid');
  const argv = [...raw];
  let action = 'inspect';
  if (argv[0] != null && !argv[0].startsWith('--')) action = argv.shift();
  if (!['inspect', 'retire'].includes(action)) throw new Error('construction retention action is unsupported');
  const selected = { action, home: null, identity: null, planDigest: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!['--home', '--subject', '--confirm'].includes(name) || seen.has(name)) throw new Error(`construction retention option is unsupported or repeated: ${name}`);
    seen.add(name);
    const value = option(argv, index, name);
    if (name === '--home') selected.home = value;
    else if (name === '--subject') selected.identity = value;
    else selected.planDigest = value;
  }
  if (action === 'inspect' && (selected.identity != null || selected.planDigest != null)) throw new Error('construction retention inspection does not accept mutation authority');
  if (action === 'retire' && (!SUBJECT.test(selected.identity ?? '') || !SHA256.test(selected.planDigest ?? ''))) {
    throw new Error('construction retention retirement requires exact --subject and --confirm values');
  }
  return Object.freeze(selected);
}

function absoluteHome(value, environment, homeDirectory) {
  const selected = value ?? environment.DEVBRIDGE_HOME ?? path.join(homeDirectory(), '.devbridge');
  if (typeof selected !== 'string' || selected.length === 0 || selected.includes('\0')) throw new TypeError('construction retention home is invalid');
  return path.resolve(selected);
}

export async function runUbuntuProductionImageRetentionCommand(argv, {
  environment = process.env,
  homeDirectory = os.homedir,
  setupStoreFactory = (location) => new JsonStateStore(location),
  authorityStoreFactory = createUbuntuConstructionAuthorityStateStore,
  authoritySelector = deriveCurrentUbuntuSetupAuthority,
  subjectFactory = ubuntuConstructionAuthoritySubject,
  retentionFactory = createUbuntuProductionImageRetention,
} = {}) {
  const selected = parseArguments(argv);
  if (!environment || typeof environment !== 'object' || typeof homeDirectory !== 'function' || typeof setupStoreFactory !== 'function'
      || typeof authorityStoreFactory !== 'function' || typeof authoritySelector !== 'function' || typeof subjectFactory !== 'function'
      || typeof retentionFactory !== 'function') throw new TypeError('construction retention command composition is incomplete');
  const home = absoluteHome(selected.home, environment, homeDirectory);
  const stateDirectory = path.join(home, 'state');
  const setup = await setupStoreFactory(path.join(stateDirectory, 'setup.json')).get(SETUP_KEY);
  if (setup?.protocol !== 'devbridge/setup-status-v1' || typeof setup?.ubuntu?.snapshot !== 'string') {
    throw new Error('construction retention requires one completed local Ubuntu setup snapshot');
  }
  const authorityEntries = await authorityStoreFactory(path.join(stateDirectory, 'production-image-canary', 'authority.json')).list();
  if (!Array.isArray(authorityEntries)) throw new Error('construction retention authority inventory is unavailable');
  const authority = await authoritySelector({
    snapshot: setup.ubuntu.snapshot,
    authorities: authorityEntries.map((entry) => entry.value),
  });
  const currentSubject = subjectFactory(authority);
  if (!SUBJECT.test(currentSubject)) throw new Error('construction retention current subject is invalid');
  const retention = await retentionFactory({ stateDirectory, currentSubject });
  if (!retention || typeof retention.inspect !== 'function' || typeof retention.retire !== 'function') {
    throw new TypeError('construction retention command target is incomplete');
  }
  return selected.action === 'inspect'
    ? retention.inspect()
    : retention.retire({ identity: selected.identity, planDigest: selected.planDigest });
}

export { parseArguments as parseUbuntuProductionImageRetentionArguments };
