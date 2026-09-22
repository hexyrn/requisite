import { Kysely, PostgresDialect } from 'kysely';
import { Pool, PoolClient } from 'pg';
import { Database } from './types';
import { getPool, resetConnectionState } from './pool';

/**
 * Wraps a single already-checked-out PoolClient so Kysely can be pointed at
 * exactly that connection for the lifetime of one transaction, instead of
 * Kysely managing its own pool checkout/release. This is what lets us
 * guarantee `set_config('app.current_organisation_id', ...)` and every query
 * issued through `db` inside withOrgContext's callback share the same
 * physical connection - the property the whole RLS design in Architecture §8
 * depends on.
 *
 * IMPORTANT (found empirically against real Postgres, not assumed): Kysely's
 * PostgresDriver calls `connection.release()` after EVERY top-level query
 * that isn't inside an explicit `db.transaction()` block - it treats each
 * query as its own acquire/release cycle against whatever "pool" it's given.
 * Since withOrgContext issues several separate top-level queries against the
 * SAME pinned client across one BEGIN/COMMIT window (not via
 * `db.transaction()`, because we need `set_config` to run as the literal
 * first statement before Kysely's own transaction machinery starts), handing
 * Kysely the real client caused it to call the real `client.release()` after
 * the FIRST query - so our own, later, deliberate release in withOrgContext's
 * finally block became a double-release and pg-pool threw "Release called on
 * client which has already been released to the pool."
 *
 * Fix: give Kysely a proxy that forwards everything except `release()`,
 * which becomes a no-op. Only withOrgContext's own finally block (holding
 * the real, unproxied `client` reference) ever calls the real release - so
 * there is still exactly ONE physical connection for the whole transaction,
 * and exactly ONE real release, at the end, with our DISCARD ALL safety net
 * in front of it.
 */
function singleConnectionPool(client: PoolClient): Pool {
  const releaseSwallowingProxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'release') {
        return () => undefined;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PoolClient;

  return {
    connect: async () => releaseSwallowingProxy,
    // Kysely calls end() only if it owns the pool lifecycle - it doesn't here.
    end: async () => undefined,
    on: () => undefined,
  } as unknown as Pool;
}

export class OrgContextRequiredError extends Error {
  constructor() {
    super(
      'withOrgContext requires a non-empty organisationId - there is no code path that runs without one.',
    );
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
  // A checked-out pg Client emits its OWN 'error' event (distinct from the
  // pool's idle-client 'error') when its connection drops while in use -
  // e.g. the backend is killed mid-transaction. Node's EventEmitter throws
  // if an 'error' event has no listener, which surfaces as an unhandled
  // rejection that can crash the process. Found empirically while testing
  // connection-drop handling (§8.2 matrix item 4). We already detect and
  // react to the failure via the thrown query error below; this listener
  // exists solely to stop that *duplicate* 'error' emission from being
  // unhandled - it intentionally does nothing beyond that. IMPORTANT: `pg`
  // reuses the same physical Client object across many pool.connect() calls
  // for the life of the pool, so this listener MUST be removed in the
  // finally block below - leaving it attached forever accumulates one
  // listener per withOrgContext call on the same reused client and trips
  // Node's MaxListenersExceededWarning (found empirically running the full
  // suite: "11 error listeners added to [Client]").
  const swallowClientError = () => undefined;
  client.on('error', swallowClientError);
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: singleConnectionPool(client) }),
  });

  let connectionIsHealthy = true;
  try {
    await client.query('BEGIN');
    try {
      // NOTE: `SET LOCAL x = $1` is not valid Postgres syntax - SET/SET LOCAL
      // only accept a literal, not a bind parameter (confirmed empirically:
      // it throws "syntax error at or near $1"). set_config() is a regular
      // function, so it DOES accept a bind parameter, and with is_local=true
      // it is exactly equivalent to SET LOCAL (transaction-scoped, reverts
      // on COMMIT/ROLLBACK) - this is the correct, injection-safe way to set
      // a parameterized GUC per Postgres's own documentation.
      await client.query("SELECT set_config('app.current_organisation_id', $1, true)", [
        organisationId,
      ]);
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
    client.removeListener('error', swallowClientError);
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
  const swallowClientError = () => undefined;
  client.on('error', swallowClientError); // see the identical note in withOrgContext above
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: singleConnectionPool(client) }),
  });
  try {
    return await fn(db);
  } finally {
    await db.destroy().catch(() => undefined);
    client.removeListener('error', swallowClientError);
    await resetConnectionState(client).catch(() => undefined);
    client.release();
  }
}
