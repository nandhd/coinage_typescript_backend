/**
 * Minimal per-key token bucket used to honour SnapTrade's recommendation of
 * throttling crypto order placement to one request per second per account.
 */
type AcquireResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export class PerKeyRateLimiter {
  private readonly lastExecution = new Map<string, number>();

  constructor(private readonly minIntervalMs: number) {}

  /**
   * Attempts to acquire a token for the supplied key. Callers exceeding the
   * configured rate receive a retry-after hint in milliseconds.
   */
  tryAcquire(key: string): AcquireResult {
    const now = Date.now();
    const last = this.lastExecution.get(key);

    if (last === undefined || now - last >= this.minIntervalMs) {
      this.lastExecution.set(key, now);
      return { allowed: true };
    }

    // Calculate how long the caller should wait before retrying.
    return {
      allowed: false,
      retryAfterMs: this.minIntervalMs - (now - last)
    };
  }

  /**
   * Clears internal state. Exposed for deterministic tests; not used in prod.
   */
  reset(): void {
    this.lastExecution.clear();
  }
}
