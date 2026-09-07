const INPUT_KEYS = Object.freeze(['changed', 'persisted', 'visible']);

export function classifyPathVisibility(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('path visibility input must be an object');
  }
  const keys = Object.keys(input).sort((left, right) => left.localeCompare(right));
  if (keys.length !== INPUT_KEYS.length || keys.some((key, index) => key !== INPUT_KEYS[index])) {
    throw new TypeError('path visibility input has unsupported fields');
  }
  for (const key of INPUT_KEYS) {
    if (typeof input[key] !== 'boolean') throw new TypeError(`path visibility ${key} must be boolean`);
  }
  if (!input.persisted) return 'not-persisted';
  if (input.visible) return 'available';
  return input.changed ? 'refresh-required' : 'caller-omitted';
}
