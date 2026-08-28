export function configuredQueues(config) {
  const values = config?.github?.queueRepositories;
  if (!Array.isArray(values) || values.length === 0
      || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('configured queue collection is unavailable');
  }
  return values;
}

export function selectConfiguredQueue(config, requested = null) {
  const values = configuredQueues(config);
  const selected = requested ?? values[0];
  if (!values.includes(selected)) throw new TypeError('selected queue is not configured');
  return selected;
}
