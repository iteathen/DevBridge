export function createBlockerEvaluation({ normalizeSnapshot } = {}) {
  function evaluate(rawSnapshot) {
    const snapshot = normalizeSnapshot(rawSnapshot);
    const blockers = [];
    for (const authority of snapshot.authorities) {
      if (authority.provenance === 'imported') {
        blockers.push(Object.freeze({
          code: `${authority.class}-authority-revalidation-required`,
          profile: authority.profile,
          authorityClass: authority.class,
          action: 'revalidate',
        }));
        continue;
      }
      if (authority.requirement !== 'required') continue;
      if (authority.approval !== 'approved') {
        blockers.push(Object.freeze({
          code: `${authority.class}-authority-required`,
          profile: authority.profile,
          authorityClass: authority.class,
          action: 'approve',
        }));
        continue;
      }
      if (authority.availability === 'unavailable') {
        blockers.push(Object.freeze({
          code: `${authority.class}-authority-unavailable`,
          profile: authority.profile,
          authorityClass: authority.class,
          action: 'restore',
        }));
        continue;
      }
      if (authority.availability !== 'available') {
        blockers.push(Object.freeze({
          code: `${authority.class}-authority-unverified`,
          profile: authority.profile,
          authorityClass: authority.class,
          action: 'verify',
        }));
      }
    }
    return Object.freeze(blockers);
  }

  return Object.freeze({ evaluate });
}
