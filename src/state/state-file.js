export function stateFileName(repository) {
  return `${String(repository).replace(/[^A-Za-z0-9_.-]+/g, '__')}.json`;
}
