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
  let retireConflict = null;
  let profileChoice = null;
  let windowsMediaLocation = null;
  let windowsMediaCandidate = null;
  let windowsImageIndex = null;
  let windowsMediaClass = null;
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
    if (option === '--home' || option === '--repository' || option === '--track-ref' || option === '--retire-conflict' || option === '--profiles'
        || option === '--windows-media' || option === '--approve-windows-media' || option === '--windows-image-index' || option === '--windows-media-class') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new PolicyError(`${option} requires a value`);
      if (option === '--home') {
        if (home != null) throw new PolicyError('--home may be specified only once');
        home = value;
      } else if (option === '--track-ref') {
        if (trackRef != null) throw new PolicyError('--track-ref may be specified only once');
        trackRef = value;
      } else if (option === '--retire-conflict') {
        if (retireConflict != null) throw new PolicyError('--retire-conflict may be specified only once');
        if (!/^[0-9a-f]{64}$/u.test(value)) throw new PolicyError('--retire-conflict requires an exact conflict consent subject');
        retireConflict = value;
      } else if (option === '--profiles') {
        if (profileChoice != null) throw new PolicyError('--profiles may be specified only once');
        if (!['linux', 'windows', 'both', 'none', 'defer'].includes(value)) {
          throw new PolicyError('--profiles must be linux, windows, both, none, or defer');
        }
        profileChoice = value;
      } else if (option === '--windows-media') {
        if (windowsMediaLocation != null) throw new PolicyError('--windows-media may be specified only once');
        const pathApi = platform === 'win32' ? path.win32 : path.posix;
        if (!pathApi.isAbsolute(value)) throw new PolicyError('--windows-media requires one absolute local ISO path');
        windowsMediaLocation = value;
      } else if (option === '--approve-windows-media') {
        if (windowsMediaCandidate != null) throw new PolicyError('--approve-windows-media may be specified only once');
        if (!/^candidate-[a-f0-9]{32}$/u.test(value)) throw new PolicyError('--approve-windows-media requires an exact candidate subject');
        windowsMediaCandidate = value;
      } else if (option === '--windows-image-index') {
        if (windowsImageIndex != null) throw new PolicyError('--windows-image-index may be specified only once');
        if (!/^\d+$/u.test(value)) throw new PolicyError('--windows-image-index requires a positive integer');
        windowsImageIndex = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(windowsImageIndex) || windowsImageIndex < 1 || windowsImageIndex > 512) throw new PolicyError('--windows-image-index requires an integer from 1 through 512');
      } else if (option === '--windows-media-class') {
        if (windowsMediaClass != null) throw new PolicyError('--windows-media-class may be specified only once');
        if (!['official-owned', 'evaluation'].includes(value)) throw new PolicyError('--windows-media-class must be official-owned or evaluation');
        windowsMediaClass = value;
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
  const approvalParts = [windowsMediaCandidate, windowsImageIndex, windowsMediaClass].filter((value) => value != null).length;
  if (windowsMediaLocation != null && approvalParts > 0) throw new PolicyError('discover Windows media before approving an exact candidate in a later setup invocation');
  if (approvalParts !== 0 && approvalParts !== 3) throw new PolicyError('Windows media approval requires --approve-windows-media, --windows-image-index, and --windows-media-class together');
  if (construct && ['none', 'defer'].includes(profileChoice)) {
    throw new PolicyError('--construct requires at least one selected execution profile');
  }
  if ((windowsMediaLocation != null || approvalParts > 0) && ['linux', 'none', 'defer'].includes(profileChoice)) {
    throw new PolicyError('Windows media options require the Windows execution profile');
  }
  if (lifecycleAuthorityChild && (construct || trackRef != null || retireConflict != null || profileChoice != null || windowsMediaLocation != null || approvalParts > 0 || repositories.length > 0)) {
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
    retireConflict,
    profileChoice,
    windowsMediaLocation,
    windowsMediaApproval: windowsMediaCandidate == null ? null : Object.freeze({
      candidate: windowsMediaCandidate,
      imageIndex: windowsImageIndex,
      sourceClass: windowsMediaClass,
    }),
    repositories: Object.freeze(repositories),
    lifecycleAuthorityChild,
    entryNoUpdate,
  });
}
