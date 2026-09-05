import os from 'node:os';
import process from 'node:process';
import { observeCurrentPrincipal } from './current-principal-observation.js';

export function observeLocalPrincipal() {
  return observeCurrentPrincipal({}, {
    readRecord() {
      const value = os.userInfo({ encoding: 'utf8' });
      return {
        name: value.username,
        identityId: value.uid,
        primaryCapabilityId: value.gid,
      };
    },
    readRealIdentityId: process.getuid,
    readEffectiveIdentityId: process.geteuid,
    readRealPrimaryCapabilityId: process.getgid,
    readEffectivePrimaryCapabilityId: process.getegid,
  });
}
