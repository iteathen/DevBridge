function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

export function createProgressCoordinator({ maximumAdvances, measureReadiness, messages }) {
  if (!Number.isSafeInteger(maximumAdvances) || maximumAdvances < 1) throw new TypeError('progress advancement limit is invalid');
  requiredFunction(measureReadiness, 'progress readiness measurement');
  if (!messages || typeof messages !== 'object') throw new TypeError('progress messages are invalid');
  for (const name of ['evidenceUnavailable', 'progressing', 'slow', 'progressPending', 'progressUnavailable', 'outputNotReady', 'shutdownPending', 'advancementLimit']) {
    if (typeof messages[name] !== 'string' || messages[name].length === 0) throw new TypeError(`progress messages.${name} is invalid`);
  }
  for (const name of ['progressBlocked', 'lifecyclePending', 'endpointNotReady', 'endpointUnready', 'readinessExpired']) requiredFunction(messages[name], `progress messages.${name}`);

  const run = async (operations) => {
    const inspect = requiredFunction(operations?.inspect, 'progress inspection');
    const advance = requiredFunction(operations?.advance, 'progress advancement');
    const observeProgress = requiredFunction(operations?.observeProgress, 'progress observation');
    const observeLifecycle = requiredFunction(operations?.observeLifecycle, 'lifecycle observation');
    const resolveEndpoint = requiredFunction(operations?.resolveEndpoint, 'endpoint resolution');
    const inspectEndpoint = requiredFunction(operations?.inspectEndpoint, 'endpoint inspection');
    const reconcileCompletion = requiredFunction(operations?.reconcileCompletion, 'completion reconciliation');
    const present = requiredFunction(operations?.present, 'progress presentation');
    if (operations.captureEvidence != null && typeof operations.captureEvidence !== 'function') throw new TypeError('evidence capture must be a function');

    for (let index = 0; index < maximumAdvances; index += 1) {
      const current = await inspect();
      if (current.complete) {
        const reason = await reconcileCompletion();
        return present(current, { state: 'completed', reason });
      }
      if (current.blocked) return present(current, { state: 'blocked', reason: current.reason });

      if (current.phase === 'running') {
        const observed = await observeProgress();
        if (observed.state === 'running' && observed.mediaCount > 0) {
          const classification = observed.liveness?.classification ?? null;
          let diagnostics = null;
          if (['slow', 'stalled', 'overdue'].includes(classification)) {
            if (typeof operations.captureEvidence !== 'function') diagnostics = Object.freeze({ available: false, reason: messages.evidenceUnavailable });
            else {
              try { diagnostics = await operations.captureEvidence(); }
              catch (error) { diagnostics = Object.freeze({ available: false, reason: String(error?.message ?? error).slice(0, 512) }); }
            }
          }
          if (classification === 'stalled' || classification === 'overdue') {
            return present(current, { state: 'blocked', reason: messages.progressBlocked(classification), liveness: observed.liveness, diagnostics });
          }
          const reason = classification === 'progressing'
            ? messages.progressing
            : classification === 'slow'
              ? messages.slow
              : observed.liveness
                ? messages.progressPending
                : messages.progressUnavailable;
          return present(current, { state: 'waiting', reason, liveness: observed.liveness ?? null, diagnostics });
        }
        if (observed.state !== 'off' && !(observed.state === 'running' && observed.mediaCount === 0)) return present(current, { state: 'waiting', reason: messages.lifecyclePending(observed.state) });
      }

      if (current.phase === 'active') {
        const observed = await observeLifecycle();
        if (observed.state !== 'running' || observed.mediaCount !== 0) return present(current, { state: 'waiting', reason: messages.outputNotReady });
        const pendingEndpoint = (reason) => {
          const readiness = measureReadiness(observed.uptimeMilliseconds);
          if (readiness.classification === 'expired') return present(current, { state: 'blocked', reason: messages.readinessExpired(reason), readiness });
          return present(current, { state: 'waiting', reason, readiness });
        };
        let endpoint;
        try { endpoint = await resolveEndpoint(); }
        catch (error) { return pendingEndpoint(messages.endpointNotReady(error.message)); }
        const inspected = await inspectEndpoint(endpoint);
        if (inspected.ready !== true) return pendingEndpoint(messages.endpointUnready(inspected.reason ?? 'unknown failure'));
      }

      if (current.phase === 'finalized') {
        const observed = await observeLifecycle();
        if (observed.state !== 'off') return present(current, { state: 'waiting', reason: messages.shutdownPending });
      }

      const advanced = await advance();
      if (advanced.blocked) return present(advanced, { state: 'blocked', reason: advanced.reason });
    }
    return present(await inspect(), { state: 'waiting', reason: messages.advancementLimit });
  };

  return Object.freeze({ run });
}
