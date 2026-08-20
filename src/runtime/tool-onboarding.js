import { parseCliHelp } from './cli-help-parser.js';

function availabilityOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.ready !== 'boolean') throw new TypeError('probe availability is invalid');
  return { ready: raw.ready, reason: raw.reason == null ? null : String(raw.reason).slice(0, 2_048) };
}

function observationOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('probe observation is invalid');
  if (!Number.isSafeInteger(raw.exitCode) && raw.exitCode !== null) throw new TypeError('probe exitCode is invalid');
  for (const name of ['timedOut', 'aborted', 'outputTruncated']) {
    if (typeof raw[name] !== 'boolean') throw new TypeError(`probe ${name} is invalid`);
  }
  if (typeof raw.stdout !== 'string' || typeof raw.stderr !== 'string') throw new TypeError('probe output is invalid');
  return raw;
}

function assertPorts(probe, records) {
  if (!probe || typeof probe.inspect !== 'function' || typeof probe.run !== 'function') throw new TypeError('probe port is incomplete');
  if (!records || typeof records.restore !== 'function' || typeof records.has !== 'function' || typeof records.publish !== 'function') throw new TypeError('record port is incomplete');
}

export class ToolOnboarding {
  #entries;
  #probeTimeoutMs;
  #maxHelpBytes;

  constructor({ entries = [], probeTimeoutMs = 15_000, maxHelpBytes = 256 * 1024 } = {}) {
    if (!Array.isArray(entries) || entries.length > 32) throw new TypeError('onboarding entries are invalid');
    if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1_000 || probeTimeoutMs > 60_000) throw new TypeError('probeTimeoutMs is invalid');
    if (!Number.isSafeInteger(maxHelpBytes) || maxHelpBytes < 4_096 || maxHelpBytes > 256 * 1024) throw new TypeError('maxHelpBytes is invalid');
    this.#entries = entries.map((entry) => Object.freeze({ command: entry.command, operation: entry.operation, helpArgs: Object.freeze([...entry.helpArgs]) }));
    this.#probeTimeoutMs = probeTimeoutMs;
    this.#maxHelpBytes = maxHelpBytes;
  }

  async reconcile({ probe, records, context = null } = {}) {
    if (this.#entries.length === 0) return { changed: false, events: [] };
    assertPorts(probe, records);
    const events = [];
    let changed = false;
    const availability = availabilityOf(probe.inspect());
    for (const entry of this.#entries) {
      const restored = await records.restore(entry);
      if (restored) {
        events.push({ command: entry.command, operation: entry.operation, state: 'available-existing', helpSha256: restored.helpSha256 ?? null });
        continue;
      }
      if (records.has(entry.operation)) {
        events.push({ command: entry.command, operation: entry.operation, state: 'available' });
        continue;
      }
      if (!availability.ready) {
        events.push({ command: entry.command, operation: entry.operation, state: 'probe-unavailable', reason: availability.reason ?? 'probe is not ready' });
        continue;
      }
      if (context == null) {
        events.push({ command: entry.command, operation: entry.operation, state: 'probe-context-required', reason: 'probing requires an exact context' });
        continue;
      }
      const observation = observationOf(await probe.run({
        name: entry.operation,
        command: entry.command,
        arguments: [...entry.helpArgs],
        context,
        environment: { CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', DEVBRIDGE_NONINTERACTIVE: '1' },
        limits: { timeoutMs: this.#probeTimeoutMs, maxOutputBytes: this.#maxHelpBytes },
      }));
      if (observation.timedOut || observation.aborted || observation.outputTruncated || observation.exitCode !== 0) {
        const reason = String(observation.stderr || observation.stdout || 'probe failed').trim().slice(0, 2_048);
        events.push({ command: entry.command, operation: entry.operation, state: 'probe-failed', reason });
        continue;
      }
      const parsed = parseCliHelp([observation.stdout, observation.stderr].filter(Boolean).join('\n'));
      await records.publish({ entry, parsed });
      changed = true;
      events.push({ command: entry.command, operation: entry.operation, state: 'available-probed', helpSha256: parsed.helpSha256 });
    }
    return { changed, events };
  }
}
