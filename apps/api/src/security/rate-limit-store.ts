/**
 * Replaceable rate-limit storage backend. P1 item 16: "the architecture
 * must retain a replaceable rate-limit store/interface so a shared backend
 * can be introduced later" - the in-memory limiter (still the right choice
 * for P1's single-process deployment shape) now sits behind this interface
 * rather than owning its state directly, so a future shared backend (a
 * Postgres table, Redis if that constraint is ever revisited) is a new
 * class implementing this interface, not a rewrite of every call site that
 * uses `AccountRateLimiter`.
 */
export interface RateLimitStore {
  /** Returns the timestamps (ms since epoch) of hits currently recorded for `key`. */
  getHits(key: string): number[];
  /** Replaces the recorded hits for `key` (already filtered to the current window by the caller). */
  setHits(key: string, hits: number[]): void;
  /** Removes all recorded hits for `key`. */
  clear(key: string): void;
  /** Iterates every known key - used only by sweep() for periodic cleanup. */
  keys(): IterableIterator<string>;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();

  getHits(key: string): number[] {
    return this.hits.get(key) ?? [];
  }

  setHits(key: string, hits: number[]): void {
    if (hits.length === 0) {
      this.hits.delete(key);
    } else {
      this.hits.set(key, hits);
    }
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.hits.keys();
  }
}
