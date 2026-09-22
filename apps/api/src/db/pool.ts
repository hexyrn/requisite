import { Pool, PoolClient } from 'pg';
import { logStructured } from '../logging/logger';

let sharedPool: Pool | undefined;

/**
 * `pg.Pool` emits an 'error' event whenever an IDLE client's underlying
 * connection is terminated unexpectedly (e.g. the backend was killed, the
 * network dropped). This is separate from any error thrown by an in-flight
 * query. If nothing listens for it, Node treats it as an unhandled
 * exception and can crash the whole process - this was found empirically
 * while writing the connection-drop test in the RLS matrix suite (item 4),
 * where a genuinely dropped connection surfaced as an unhandled rejection
 * rather than a clean test failure. Every Pool this module hands out gets
 * this listener so a single flaky connection can never take the process
 * down; `pg`'s own documentation recommends exactly this pattern.
 */
export function attachPoolErrorHandler(pool: Pool): Pool {
  pool.on('error', (err) => {
    logStructured({
      event: 'db.pool.idle_client_error',
      errorCode: (err as any)?.code ?? 'UNKNOWN',
      context: { message: err.message },
    });
  });
  return pool;
}

export function getPool(): Pool {
  if (!sharedPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    sharedPool = attachPoolErrorHandler(new Pool({ connectionString }));
  }
  return sharedPool;
}

/** Test/teardown helper - allows tests to point the shared pool at a fresh Pool instance. */
export function setPool(pool: Pool): void {
  sharedPool = pool;
}

export async function closePool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = undefined;
  }
}

/**
 * Second-layer safety net per Architecture §8: even if a coding mistake
 * skipped the transaction wrapper and left session-level state set on a
 * connection, DISCARD ALL resets it before the connection can be handed to
 * a different request/org. Called from withOrgContext's finally block.
 */
export async function resetConnectionState(client: PoolClient): Promise<void> {
  try {
    await client.query('DISCARD ALL');
  } catch {
    // If DISCARD ALL itself fails, we cannot trust this connection's state at
    // all - release it with an error so `pg` destroys the physical
    // connection instead of returning it to the pool for reuse.
    throw new Error('DISCARD_ALL_FAILED');
  }
}
