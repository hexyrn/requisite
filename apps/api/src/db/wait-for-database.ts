import { Pool } from 'pg';
import { logStructured } from '../logging/logger';

export interface WaitOptions {
  /** Give up after this long (default 5 minutes: enough for PostgreSQL crash recovery after a power cut). */
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Waits until the database accepts connections. On Windows the database is a separate service that can still be
 * starting (or recovering after an unclean shutdown) when this service starts after a reboot; exiting immediately
 * would only cause a restart loop. Retries with capped backoff, logging each wait, and fails clearly on timeout.
 */
export async function waitForDatabase(
  connectionString: string,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  let delay = options.initialDelayMs ?? 1000;
  for (let attempt = 1; ; attempt++) {
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
    pool.on('error', () => undefined);
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) logStructured({ event: 'db.available', context: { attempts: attempt } });
      return;
    } catch (err) {
      const waited = now() - started;
      if (waited >= timeoutMs) {
        throw new Error(
          `The database did not become available within ${Math.round(timeoutMs / 1000)} seconds (${err instanceof Error ? err.message : String(err)}). Check that the "Requisite Database (PostgreSQL)" service is running.`,
        );
      }
      logStructured({
        event: 'db.waiting',
        context: { attempt, message: err instanceof Error ? err.message : String(err) },
      });
      await sleep(delay);
      delay = Math.min(delay * 2, options.maxDelayMs ?? 15_000);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
}
