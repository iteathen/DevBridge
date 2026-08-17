import type { Clock } from "../../ports/clock.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("sleep aborted"));
      };
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
