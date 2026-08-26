import path from 'node:path';
import process from 'node:process';
import { PolicyError } from '../errors.js';

function sameLocalPath(left, right, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const a = pathApi.resolve(left);
  const b = pathApi.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function parseSetupCommandOptions(argv, {
  authorityHome = null,
  platform = process.platform,
} = {}) {
  let home = null;
  let construct = false;
  let trackRef = null;
  let lifecycleAuthorityChild = false;
  let entryNoUpdate = false;
  const repositories = [];
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--construct') {
      if (construct) throw new PolicyError('--construct may be specified only once');
      construct = true;
      continue;
    }
    if (option === '--lifecycle-authority-child') {
      if (lifecycleAuthorityChild) throw new PolicyError('--lifecycle-authority-child may be specified only once');
      lifecycleAuthorityChild = true;
      continue;
    }
    if (option === '--no-update') {
      if (entryNoUpdate) throw new PolicyError('--no-update may be specified only once');
      entryNoUpdate = true;
      continue;
    }
    if (option === '--home' || option === '--repository' || option === '--track-ref') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new PolicyError(`${option} requires a value`);
      if (option === '--home') {
        if (home != null) throw new PolicyError('--home may be specified only once');
        home = value;
      } else if (option === '--track-ref') {
        if (trackRef != null) throw new PolicyError('--track-ref may be specified only once');
        trackRef = value;
      } else {
        repositories.push(value);
      }
      index += 1;
      continue;
    }
    throw new PolicyError(`unsupported setup option: ${option}`);
  }
  if (entryNoUpdate && !lifecycleAuthorityChild) {
    throw new PolicyError('--no-update is reserved for the lifecycle-authority child');
  }
  if (lifecycleAuthorityChild && (construct || trackRef != null || repositories.length > 0)) {
    throw new PolicyError('lifecycle-authority child accepts no setup capability arguments');
  }
  if (lifecycleAuthorityChild && home != null
      && (typeof authorityHome !== 'string'
        || !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(home)
        || !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(authorityHome)
        || !sameLocalPath(home, authorityHome, platform))) {
    throw new PolicyError('lifecycle-authority child accepts only its exact broker-bound setup home');
  }
  return Object.freeze({
    home,
    construct,
    trackRef,
    repositories: Object.freeze(repositories),
    lifecycleAuthorityChild,
    entryNoUpdate,
  });
}
