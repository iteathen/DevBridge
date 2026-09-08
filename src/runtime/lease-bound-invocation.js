export function bindInvocationToLease(invoke, context) {
  if (typeof invoke !== 'function' || typeof context?.assertHeld !== 'function') throw new TypeError('native mutation lease context is invalid');
  return async (request) => {
    context.assertHeld();
    const signal = context.signal == null ? request.signal : request.signal == null
      ? context.signal : AbortSignal.any([context.signal, request.signal]);
    const result = await invoke({ ...request, ...(signal == null ? {} : { signal }) });
    context.assertHeld();
    return result;
  };
}
