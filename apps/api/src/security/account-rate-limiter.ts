/**
 * Account/identity-keyed rate limiting - the second, independent dimension
 * alongside the IP/source-based limiting registered via @fastify/rate-limit
 * in main.ts. Architecture requires "no mandatory Redis", so this is a
 * simple in-memory sliding-window counter per process, which is honest
 * about its scope: it protects a single Core instance from being hammered
 * against one account/email regardless of which source IP the requests come
 * from (an attacker rotating IPs still hits this limit), but it does NOT
 * share state across multiple Core processes/replicas. For P0's target
 * deployment shape (single Node process, per Architecture's modular-
 * monolith decision) this is exactly sufficient; a future horizontally-
 * scaled deployment would need to move this to a shared store (e.g. the
 * existing Postgres-backed job/queue infrastructure, or Redis if that
 * constraint is ever revisited) - documented here rather than silently
 * assumed to already be multi-instance-safe.
 */
export class AccountRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if this key is currently allowed to proceed (and records the attempt). */
  consume(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const existing = (this.hits.get(key) ?? []).filter((t) => t > windowStart);

    if (existing.length >= this.maxAttempts) {
      this.hits.set(key, existing);
      return false;
    }

    existing.push(now);
    this.hits.set(key, existing);
    return true;
  }

  /** For tests / explicit resets (e.g. after a successful attempt). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Periodic cleanup to bound memory - safe to call on a timer; not required for correctness. */
  sweep(): void {
    const now = Date.now();
    for (const [key, hits] of this.hits.entries()) {
      const kept = hits.filter((t) => t > now - this.windowMs);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}
