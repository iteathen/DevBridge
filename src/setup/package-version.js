const DIGIT = /^[0-9]$/u;
const LETTER = /^[A-Za-z]$/u;
const VERSION = /^(?:[0-9]+:)?[A-Za-z0-9][A-Za-z0-9.+:~_-]*$/u;

function characterOrder(value) {
  if (value === '~') return -1;
  if (value === '') return 0;
  if (LETTER.test(value)) return value.codePointAt(0);
  return value.codePointAt(0) + 256;
}

function comparePart(left, right) {
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length || rightIndex < right.length) {
    while (
      (leftIndex < left.length && !DIGIT.test(left[leftIndex]))
      || (rightIndex < right.length && !DIGIT.test(right[rightIndex]))
    ) {
      const leftCharacter = leftIndex < left.length && !DIGIT.test(left[leftIndex]) ? left[leftIndex] : '';
      const rightCharacter = rightIndex < right.length && !DIGIT.test(right[rightIndex]) ? right[rightIndex] : '';
      const order = characterOrder(leftCharacter) - characterOrder(rightCharacter);
      if (order !== 0) return Math.sign(order);
      if (leftCharacter !== '') leftIndex += 1;
      if (rightCharacter !== '') rightIndex += 1;
    }

    while (left[leftIndex] === '0') leftIndex += 1;
    while (right[rightIndex] === '0') rightIndex += 1;

    const leftStart = leftIndex;
    const rightStart = rightIndex;
    while (leftIndex < left.length && DIGIT.test(left[leftIndex])) leftIndex += 1;
    while (rightIndex < right.length && DIGIT.test(right[rightIndex])) rightIndex += 1;
    const leftLength = leftIndex - leftStart;
    const rightLength = rightIndex - rightStart;
    if (leftLength !== rightLength) return leftLength < rightLength ? -1 : 1;
    for (let offset = 0; offset < leftLength; offset += 1) {
      if (left[leftStart + offset] !== right[rightStart + offset]) {
        return left[leftStart + offset] < right[rightStart + offset] ? -1 : 1;
      }
    }
  }
  return 0;
}

function parseVersion(value, name) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw new TypeError(`${name} is invalid`);
  const colon = value.indexOf(':');
  if (colon !== -1 && (!/^[0-9]+$/u.test(value.slice(0, colon)) || value.indexOf(':', colon + 1) !== -1)) {
    throw new TypeError(`${name} is invalid`);
  }
  const epochText = colon === -1 ? '0' : value.slice(0, colon);
  const remainder = colon === -1 ? value : value.slice(colon + 1);
  const hyphen = remainder.lastIndexOf('-');
  if (hyphen === remainder.length - 1) throw new TypeError(`${name} is invalid`);
  return Object.freeze({
    epoch: BigInt(epochText),
    upstream: hyphen === -1 ? remainder : remainder.slice(0, hyphen),
    revision: hyphen === -1 ? '' : remainder.slice(hyphen + 1),
  });
}

export function comparePackageVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue, 'left package version');
  const right = parseVersion(rightValue, 'right package version');
  if (left.epoch !== right.epoch) return left.epoch < right.epoch ? -1 : 1;
  const upstream = comparePart(left.upstream, right.upstream);
  if (upstream !== 0) return upstream;
  return comparePart(left.revision, right.revision);
}
