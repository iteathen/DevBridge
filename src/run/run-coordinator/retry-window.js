const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

export class RetryWindowError extends Error {}

export class RetryWindow {
  #now;
  #wait;

  constructor({ now, wait }) {
    this.#now = now;
    this.#wait = wait;
  }

  async respect(record) {
    if (!record?.notBefore) return false;
    const deadline = Date.parse(record.notBefore);
    if (!Number.isFinite(deadline)) throw new RetryWindowError('persisted transient retry deadline is malformed');
    const remaining = deadline - this.#now();
    if (remaining > 0) await this.#wait(remaining);
    return true;
  }

  schedule({ current, completed, limit, classification, kind }) {
    const attempts = (current?.attempts ?? 0) + 1;
    const observedAt = new Date(this.#now()).toISOString();
    if (completed >= limit) {
      return {
        record: {
          classification: classification ?? 'TRANSIENT',
          kind: kind ?? 'tool-availability',
          attempts,
          delayMs: 0,
          notBefore: null,
          exhausted: true,
          lastAt: observedAt,
        },
        scheduled: null,
      };
    }

    const exponent = Math.max(0, Math.min(20, attempts - 1));
    const delayMs = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** exponent));
    const notBefore = new Date(this.#now() + delayMs).toISOString();
    return {
      record: {
        classification: classification ?? 'TRANSIENT',
        kind: kind ?? 'tool-availability',
        attempts,
        delayMs,
        notBefore,
        exhausted: false,
        lastAt: observedAt,
      },
      scheduled: { attempts, delayMs, notBefore },
    };
  }
}
