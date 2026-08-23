import { createCanonicalImageCanary } from './canonical-image-canary.js';

function requireMethods(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

export function createUbuntuProductionImageCanaryComposition({ journal, construction, qualification, foundation } = {}) {
  const selectedConstruction = requireMethods(
    construction,
    ['prepare', 'status', 'startInstall', 'bootInstalled', 'markQualified', 'retain'],
    'production image construction',
  );
  const selectedQualification = requireMethods(qualification, ['probe', 'finalize'], 'production image qualification');
  const selectedFoundation = requireMethods(foundation, ['publishImage', 'verifyImage'], 'production image foundation');

  return createCanonicalImageCanary({
    journal,
    construction: Object.freeze({
      prepare: (input) => selectedConstruction.prepare(input),
      observe: (identity) => selectedConstruction.status(identity),
      start: (identity) => selectedConstruction.startInstall(identity),
      activate: (identity) => selectedConstruction.bootInstalled(identity),
      accept: (identity, evidence) => selectedConstruction.markQualified(identity, evidence),
      retain: (identity) => selectedConstruction.retain(identity),
    }),
    qualification: Object.freeze({
      probe: (input) => selectedQualification.probe(input),
      finalize: (identity) => selectedQualification.finalize(identity),
    }),
    images: Object.freeze({
      publish: (input) => selectedFoundation.publishImage(input),
      verify: (identity) => selectedFoundation.verifyImage(identity),
    }),
  });
}
