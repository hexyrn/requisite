import { Pool, PoolClient } from 'pg';

let sharedPool: Pool | undefined;

export function getPool(): Pool {
  if (!sharedPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    sharedPool = new Pool({ connectionString });
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
