import { createCanonicalImageCanary } from './canonical-image-canary.js';

const CONSTRUCTION_STATE = Object.freeze({
  absent: 'absent',
  planned: 'planned',
  prepared: 'prepared',
  installing: 'running',
  qualifying: 'active',
  qualified: 'accepted',
  retained: 'retained',
});

function requireMethods(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} contract is incomplete`);
  return value;
}

async function observeConstruction(construction, identity) {
  const observed = await construction.status(identity);
  if (!observed || typeof observed !== 'object' || Array.isArray(observed) || observed.identity !== identity) {
    throw new Error('production image construction observation identity changed');
  }
  const state = CONSTRUCTION_STATE[observed.phase];
  if (!state) throw new Error('production image construction observation phase is unsupported');
  return Object.freeze({ identity, state });
}

export function createUbuntuProductionImageCanaryComposition({ journal, preparation, construction, qualification, foundation } = {}) {
  const selectedPreparation = requireMethods(preparation, ['prepare'], 'production image preparation');
  const selectedConstruction = requireMethods(
    construction,
    ['status', 'startInstall', 'bootInstalled', 'markQualified', 'retain'],
    'production image construction',
  );
  const selectedQualification = requireMethods(qualification, ['probe', 'finalize'], 'production image qualification');
  const selectedFoundation = requireMethods(foundation, ['publishImage', 'verifyImage'], 'production image foundation');

  return createCanonicalImageCanary({
    journal,
    construction: Object.freeze({
      prepare: (input) => selectedPreparation.prepare(input),
      observe: (identity) => observeConstruction(selectedConstruction, identity),
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