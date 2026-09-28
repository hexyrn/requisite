import { RateLimitStore, InMemoryRateLimitStore } from './rate-limit-store';

/**
 * Account/identity-keyed rate limiting - the second, independent dimension
 * alongside the IP/source-based limiting applied per-endpoint in the auth/
 * password-reset/invitation controllers. Architecture requires "no
 * mandatory Redis"; the default `InMemoryRateLimitStore` is honest about
 * its scope (single-process only, documented there), but storage is now
 * behind the `RateLimitStore` interface (P1 item 16) so a future shared
 * backend is a constructor argument, not a rewrite.
 */
export class AccountRateLimiter {
  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly store: RateLimitStore = new InMemoryRateLimitStore(),
  ) {}

  /** Returns true if this key is currently allowed to proceed (and records the attempt). */
  consume(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const existing = this.store.getHits(key).filter((t) => t > windowStart);

    if (existing.length >= this.maxAttempts) {
      this.store.setHits(key, existing);
      return false;
    }

    existing.push(now);
    this.store.setHits(key, existing);
    return true;
  }

  /** For tests / explicit resets (e.g. after a successful attempt). */
  reset(key: string): void {
    this.store.clear(key);
  }

  /** Forgets every key. For tests that share one process-wide limiter across many logins. */
  resetAll(): void {
    for (const key of [...this.store.keys()]) this.store.clear(key);
  }

  /** Periodic cleanup to bound memory - safe to call on a timer; not required for correctness. */
  sweep(): void {
    const now = Date.now();
    for (const key of [...this.store.keys()]) {
      const kept = this.store.getHits(key).filter((t) => t > now - this.windowMs);
      this.store.setHits(key, kept);
    }
  }
}
