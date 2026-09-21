import { Kysely, PostgresDialect } from 'kysely';
import { Pool, PoolClient } from 'pg';
import { Database } from './types';
import { getPool, resetConnectionState } from './pool';

/**
 * Wraps a single already-checked-out PoolClient so Kysely can be pointed at
 * exactly that connection for the lifetime of one transaction, instead of
 * Kysely managing its own pool checkout/release. This is what lets us
 * guarantee `SET LOCAL app.current_organisation_id` and every query issued
 * through `db` inside withOrgContext's callback share the same physical
 * connection - the property the whole RLS design in Architecture §8 depends
 * on. Release is a no-op here because withOrgContext owns release/cleanup.
 */
function singleConnectionPool(client: PoolClient): Pool {
  return {
    connect: async () => client,
    // Kysely calls end() only if it owns the pool lifecycle - it doesn't here.
    end: async () => undefined,
    on: () => undefined,
  } as unknown as Pool;
}

export class OrgContextRequiredError extends Error {
  constructor() {
    super('withOrgContext requires a non-empty organisationId - there is no code path that runs without one.');
    this.name = 'OrgContextRequiredError';
  }
}

/**
 * The ONLY way application code touches organisation-scoped tables.
 * Architecture §8 / §8.1: no overload omitting organisationId, wraps a
 * transaction, issues `SET LOCAL app.current_organisation_id` as the first
 * statement, and resets connection state on release regardless of outcome.
 *
 * `organisationId` is a required string at the TypeScript level - there is
 * no way to call this without one, matching the "reject before touching the
 * database" requirement in §8.1.
 */
export async function withOrgContext<T>(
  organisationId: string,
  fn: (db: Kysely<Database>) => Promise<T>,
  pool: Pool = getPool(),
): Promise<T> {
  if (!organisationId || typeof organisationId !== 'string') {
    throw new OrgContextRequiredError();
  }

  const client = await pool.connect();
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: singleConnectionPool(client) }),
  });

  let connectionIsHealthy = true;
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL app.current_organisation_id = $1', [organisationId]);
    } catch (err) {
      // Treat inability to set org context as a hard failure - never proceed
      // without it (fail closed).
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }

    let result: T;
    try {
      result = await fn(db);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Any error we couldn't already resolve above (e.g. connection dropped
    // mid-transaction) means we cannot trust this connection's state.
    connectionIsHealthy = false;
    throw err;
  } finally {
    await db.destroy().catch(() => undefined);
    if (connectionIsHealthy) {
      try {
        await resetConnectionState(client);
        client.release();
      } catch {
        // DISCARD ALL failed - do not return this connection to the pool.
        client.release(true);
      }
    } else {
      // Connection state is uncertain (e.g. dropped mid-transaction) -
      // release(true) tells `pg` to destroy the physical connection instead
      // of returning it to the pool for reuse by a different organisation.
      client.release(true);
    }
  }
}

/** Runs a query with NO organisation context set - used only to prove RLS fails closed. */
export async function withNoOrgContext<T>(
  fn: (db: Kysely<Database>) => Promise<T>,
  pool: Pool = getPool(),
): Promise<T> {
  const client = await pool.connect();
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: singleConnectionPool(client) }),
  });
  try {
    return await fn(db);
  } finally {
    await db.destroy().catch(() => undefined);
    await resetConnectionState(client).catch(() => undefined);
    client.release();
  }
}
