const ID = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,159}$/u;

export function normalizeEnvironmentOperationSubject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('environment operation subject is required');
  const keys = ['environmentIdentity', 'operationId', 'operation', 'declarationRevision', 'previousImplementationGeneration', 'imageIdentity', 'imageGeneration'];
  if (Object.keys(raw).some((key) => !keys.includes(key))) throw new TypeError('environment operation subject contains an unknown field');
  for (const key of ['environmentIdentity', 'operationId', 'imageIdentity', 'imageGeneration']) {
    if (typeof raw[key] !== 'string' || !ID.test(raw[key])) throw new TypeError(`environment operation subject ${key} is invalid`);
  }
  if (!['create', 'rebuild', 'reset', 'recreate'].includes(raw.operation)) throw new TypeError('environment operation subject operation is invalid');
  if (!Number.isSafeInteger(raw.declarationRevision) || raw.declarationRevision < 1) throw new TypeError('environment operation subject declaration revision is invalid');
  if (raw.previousImplementationGeneration != null && (typeof raw.previousImplementationGeneration !== 'string' || !ID.test(raw.previousImplementationGeneration))) throw new TypeError('environment operation subject previous generation is invalid');
  if (raw.operation !== 'create' && raw.previousImplementationGeneration == null) throw new TypeError('environment operation subject previous generation is required');
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, raw[key] ?? null])));
}

export function requireEnvironmentOperationSubject(request, operation = null) {
  const subject = normalizeEnvironmentOperationSubject(request.operationSubject);
  if (subject.environmentIdentity !== request.environmentIdentity || subject.operationId !== request.operationId
    || subject.declarationRevision !== request.declarationRevision || subject.imageIdentity !== request.declaration?.image?.identity
    || subject.imageGeneration !== request.declaration?.image?.generation || (operation != null && subject.operation !== operation)) {
    throw new Error('environment operation subject does not match request authority');
  }
  return subject;
}
