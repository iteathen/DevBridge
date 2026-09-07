const EXPECTED_MILLISECONDS = 45 * 60 * 1000;
const STALL_MILLISECONDS = 20 * 60 * 1000;
const DEADLINE_MILLISECONDS = 2 * 60 * 60 * 1000;
const RECHECK_MILLISECONDS = 2 * 60 * 1000;

export class HyperVInstallLiveness {
  checkpoint(previous, observed, instant) {
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('construction clock returned an invalid time');
    const observedAt = instant.toISOString();
    const observedMilliseconds = instant.getTime();
    const startedAt = previous?.startedAt ?? new Date(Math.max(0, observedMilliseconds - observed.uptimeMilliseconds)).toISOString();
    const startedMilliseconds = Date.parse(startedAt);
    const previousProgressMilliseconds = previous?.lastProgressAt == null ? NaN : Date.parse(previous.lastProgressAt);
    if (!Number.isFinite(startedMilliseconds) || (previous && !Number.isFinite(previousProgressMilliseconds))) throw new Error('construction install liveness checkpoint is invalid');
    const previousBytes = Number.isSafeInteger(previous?.diskAllocatedBytes) ? previous.diskAllocatedBytes : null;
    const diskGrowthBytes = previousBytes == null ? 0 : Math.max(0, observed.diskAllocatedBytes - previousBytes);
    const providerAdvanced = typeof previous?.providerStatus === 'string' && previous.providerStatus !== observed.providerStatus;
    const progressed = previous == null || diskGrowthBytes > 0 || providerAdvanced;
    const lastProgressAt = progressed ? observedAt : previous.lastProgressAt;
    const lastProgressMilliseconds = Date.parse(lastProgressAt);
    const elapsedMilliseconds = Math.max(0, observedMilliseconds - startedMilliseconds);
    const noProgressMilliseconds = Math.max(0, observedMilliseconds - lastProgressMilliseconds);
    let classification = 'observing';
    if (elapsedMilliseconds >= DEADLINE_MILLISECONDS) classification = 'overdue';
    else if (previous && noProgressMilliseconds >= STALL_MILLISECONDS) classification = 'stalled';
    else if (previous && (diskGrowthBytes > 0 || providerAdvanced)) classification = 'progressing';
    else if (elapsedMilliseconds >= EXPECTED_MILLISECONDS) classification = 'slow';
    return {
      classification,
      startedAt,
      observedAt,
      lastProgressAt,
      elapsedMilliseconds,
      noProgressMilliseconds,
      diskAllocatedBytes: observed.diskAllocatedBytes,
      diskGrowthBytes,
      cpuUsagePercent: observed.cpuUsagePercent,
      providerStatus: observed.providerStatus,
      expectedCompletionAt: new Date(startedMilliseconds + EXPECTED_MILLISECONDS).toISOString(),
      hardDeadlineAt: new Date(startedMilliseconds + DEADLINE_MILLISECONDS).toISOString(),
      nextObservationAt: ['stalled', 'overdue'].includes(classification)
        ? null
        : new Date(Math.min(observedMilliseconds + RECHECK_MILLISECONDS, startedMilliseconds + DEADLINE_MILLISECONDS)).toISOString(),
    };
  }
}
