const OWNER_START_POLL_MS = 100;
const OWNER_START_TIMEOUT_MS = 10_000;

function fail(message) { throw new Error(message); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseControlResult(command, result) {
  if (!result || !Number.isInteger(result.status)) fail(`runtime owner ${command} control returned no exit status`);
  const text = String(result.stdout || '').trim();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); }
    catch { fail(`runtime owner ${command} control returned malformed status`); }
  }
  return { status: result.status, value };
}

function ownerSubject(value) {
  if (!value?.activeLock || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.createdAt !== 'string') return null;
  return Object.freeze({ pid: value.pid, createdAt: value.createdAt });
}

function sameOwner(expected, observed) {
  return expected?.pid === observed?.pid && expected?.createdAt === observed?.createdAt;
}

export async function pauseRuntimeOwner(control, {
  signal = null,
  startPollMs = OWNER_START_POLL_MS,
  startTimeoutMs = OWNER_START_TIMEOUT_MS,
  delayFn = delay,
  nowFn = Date.now,
} = {}) {
  let expected = null;
  const startDeadline = nowFn() + Math.max(0, startTimeoutMs);
  while (!signal?.aborted) {
    if (!expected) {
      const status = parseControlResult('status', await control('status'));
      if (status.status !== 0) fail(`runtime owner status failed with exit ${status.status}`);
      expected = ownerSubject(status.value);
      if (!expected) {
        if (nowFn() >= startDeadline) fail('runtime owner did not publish a live generation before candidate transition');
        await delayFn(startPollMs);
        continue;
      }
    }

    const paused = parseControlResult('pause', await control('pause'));
    const observed = ownerSubject(paused.value);
    if (!observed || !sameOwner(expected, observed)) {
      fail('runtime owner generation changed while waiting for cooperative pause acknowledgement');
    }
    if (paused.status === 0 && paused.value?.paused === true) {
      return Object.freeze({ ...expected });
    }
    if (paused.status === 3 && paused.value?.paused === false && paused.value?.pauseRequested !== false) {
      // The exact token-bound request remains pending while the accepted owner
      // completes its current safe task cycle. Each CLI wait is bounded; the
      // supervisor keeps observing the same generation rather than suspending it.
      continue;
    }
    fail(`runtime owner pause failed with exit ${paused.status}`);
  }
  fail('runtime owner transition was interrupted before pause acknowledgement');
}

export async function resumeRuntimeOwner(control, expected) {
  const resumed = parseControlResult('resume', await control('resume'));
  if (resumed.status !== 0 || resumed.value?.resumed !== true) {
    fail(`runtime owner resume failed with exit ${resumed.status}`);
  }
  const status = parseControlResult('status', await control('status'));
  if (status.status !== 0) fail(`runtime owner status after resume failed with exit ${status.status}`);
  const observed = ownerSubject(status.value);
  if (!observed || !sameOwner(expected, observed) || status.value.pauseRequested || status.value.paused) {
    fail('runtime owner generation changed or remained paused after candidate validation failure');
  }
  return Object.freeze({ ...expected, resumed: true });
}
