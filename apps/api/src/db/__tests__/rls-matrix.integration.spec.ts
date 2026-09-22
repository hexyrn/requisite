/**
 * Architecture §8.2 P0 security test matrix.
 *
 * Requires a real Postgres (docker-compose `postgres_test` service). Run:
 *   docker compose up -d postgres_test
 *   npm test --workspace apps/api
 *
 * Covered here (matrix items 1-6, plus the two baseline §8 tests):
 *   1. Successful commit isolation
 *   2. Transaction rollback isolation
 *   3. Thrown application exception mid-transaction isolation
 *   4. Database/connection error handling (best effort)
 *   5. Concurrent requests for different organisations
 *   6. Nested service calls propagate org context
 *
 * Explicitly N/A for P0 (subsystems do not exist yet - out of P0 scope per
 * the task brief, not silently skipped):
 *   7. API tokens/service accounts - no token-auth pipeline built in P0.
 *   8. Background jobs - no job queue built in P0.
 *   9. Scheduled jobs - no scheduler built in P0.
 *   10. Event consumers - no event bus/outbox built in P0.
 *   11. Webhooks - no webhook framework built in P0.
 *   12. Async imports/exports - no import/export subsystem built in P0.
 * These all depend on infrastructure (job queue, event bus, API token
 * issuance) that is explicitly P1+ per the architecture's phased plan and
 * the P0 task brief's exclusion list. withOrgContext itself has no
 * knowledge of *why* it's being called, so once those subsystems exist they
 * reuse the exact same wrapper tested here - there is nothing additional to
 * build in withOrgContext itself for them to be safe.
 */
import { Pool } from 'pg';
import { sql } from 'kysely';
import { randomUUID } from 'crypto';
import { withOrgContext, withNoOrgContext, OrgContextRequiredError } from '../org-context';
import { attachPoolErrorHandler } from '../pool';
import { setUpTestDatabase } from '../../test-utils/test-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const shouldRun = !!TEST_DATABASE_URL;

const describeIfDb = shouldRun ? describe : describe.skip;

describeIfDb('Architecture §8.2 RLS / organisation-context security matrix', () => {
  let adminPool: Pool;
  let orgA: string;
  let orgB: string;

  async function createOrg(name: string): Promise<string> {
    const id = randomUUID();
    await withOrgContext(
      id,
      async (db) => {
        await db
          .insertInto('organisations')
          .values({
            id,
            installation_id: (await ensureInstallation(db as any)) as any,
            name,
            display_name: name,
            default_currency: 'USD',
            timezone: 'UTC',
            locale: 'en-US',
            financial_year_start_month: 1,
          } as any)
          .execute();
      },
      adminPool,
    );
    return id;
  }

  async function ensureInstallation(db: any): Promise<string> {
    const existing = await db.selectFrom('installations').selectAll().executeTakeFirst();
    if (existing) return existing.id;
    const row = await db
      .insertInto('installations')
      .values({ core_version: 'test', config: {} })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row.id;
  }

  beforeAll(async () => {
    adminPool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }));
    await setUpTestDatabase(adminPool);
    orgA = await createOrg('Org A');
    orgB = await createOrg('Org B');
  }, 60000);

  afterAll(async () => {
    await adminPool.end();
  });

  it('§8 baseline: never leaks organisation context across a pooled connection reused for a different org', async () => {
    await withOrgContext(
      orgA,
      async (db) => {
        await db
          .insertInto('organisational_units')
          .values({ organisation_id: orgA, name: 'A-Unit', unit_type: 'dept' })
          .execute();
        const rows = await db.selectFrom('organisational_units').selectAll().execute();
        expect(rows.every((r) => r.organisation_id === orgA)).toBe(true);
      },
      adminPool,
    );

    // Pool max=1, so this MUST reuse the same physical connection.
    await withOrgContext(
      orgB,
      async (db) => {
        const ctx = await db
          .selectNoFrom((eb) =>
            eb
              .fn<string>('current_setting', [eb.val('app.current_organisation_id'), eb.val(true)])
              .as('ctx'),
          )
          .executeTakeFirst();
        expect(ctx?.ctx).toBe(orgB);
        const rows = await db.selectFrom('organisational_units').selectAll().execute();
        expect(rows.every((r) => r.organisation_id === orgB)).toBe(true);
        expect(rows.some((r) => r.organisation_id === orgA)).toBe(false);
      },
      adminPool,
    );
  });

  it('§8 baseline: rejects any query issued outside an org-context transaction (fail-closed)', async () => {
    const rows = await withNoOrgContext(
      (db) => db.selectFrom('organisational_units').selectAll().execute(),
      adminPool,
    );
    expect(rows.length).toBe(0);
  });

  it('1. successful commit: only that org rows are visible/written, no leak into next reused connection', async () => {
    await withOrgContext(
      orgA,
      async (db) => {
        await db.insertInto('locations').values({ organisation_id: orgA, name: 'A-HQ' }).execute();
      },
      adminPool,
    );
    await withOrgContext(
      orgA,
      async (db) => {
        const rows = await db
          .selectFrom('locations')
          .selectAll()
          .where('name', '=', 'A-HQ')
          .execute();
        expect(rows).toHaveLength(1);
        expect(rows[0].organisation_id).toBe(orgA);
      },
      adminPool,
    );
    await withOrgContext(
      orgB,
      async (db) => {
        const rows = await db
          .selectFrom('locations')
          .selectAll()
          .where('name', '=', 'A-HQ')
          .execute();
        expect(rows).toHaveLength(0);
      },
      adminPool,
    );
  });

  it('2. transaction rollback: no partial write survives, and reused connection has no residual context', async () => {
    await expect(
      withOrgContext(
        orgA,
        async (db) => {
          await db
            .insertInto('locations')
            .values({ organisation_id: orgA, name: 'RollbackMe' })
            .execute();
          throw new Error('simulated business-rule failure');
        },
        adminPool,
      ),
    ).rejects.toThrow('simulated business-rule failure');

    await withOrgContext(
      orgA,
      async (db) => {
        const rows = await db
          .selectFrom('locations')
          .selectAll()
          .where('name', '=', 'RollbackMe')
          .execute();
        expect(rows).toHaveLength(0);
      },
      adminPool,
    );

    // Reused connection: no residual context leak into the next transaction.
    await withOrgContext(
      orgB,
      async (db) => {
        const ctx = await db
          .selectNoFrom((eb) =>
            eb
              .fn<string>('current_setting', [eb.val('app.current_organisation_id'), eb.val(true)])
              .as('ctx'),
          )
          .executeTakeFirst();
        expect(ctx?.ctx).toBe(orgB);
      },
      adminPool,
    );
  });

  it('3. thrown application exception mid-transaction still rolls back and returns a clean connection', async () => {
    await expect(
      withOrgContext(
        orgA,
        async (db) => {
          await db
            .insertInto('locations')
            .values({ organisation_id: orgA, name: 'ExceptionMe' })
            .execute();
          // Simulate an unexpected bug, not a handled business exception.
          (null as any).boom();
        },
        adminPool,
      ),
    ).rejects.toThrow();

    await withOrgContext(
      orgA,
      async (db) => {
        const rows = await db
          .selectFrom('locations')
          .selectAll()
          .where('name', '=', 'ExceptionMe')
          .execute();
        expect(rows).toHaveLength(0);
      },
      adminPool,
    );

    // Pool still usable afterwards - the safety net isn't bypassed by unhandled errors.
    await withOrgContext(
      orgB,
      async (db) => {
        const rows = await db.selectFrom('locations').selectAll().execute();
        expect(rows.every((r) => r.organisation_id === orgB)).toBe(true);
      },
      adminPool,
    );
  });

  it('4. database/connection error: a connection of uncertain state is destroyed, not returned to the pool', async () => {
    const isolatedPool = attachPoolErrorHandler(
      new Pool({ connectionString: TEST_DATABASE_URL, max: 2 }),
    );
    try {
      await expect(
        withOrgContext(
          orgA,
          async (db) => {
            // Terminate our own backend mid-transaction to simulate a dropped connection.
            await sql`SELECT pg_terminate_backend(pg_backend_pid())`.execute(db);
            // The connection is now dead; this next statement must throw.
            await sql`SELECT 1`.execute(db);
          },
          isolatedPool,
        ),
      ).rejects.toThrow();

      // Pool must still be usable via a fresh connection - proves the broken
      // connection was discarded rather than corrupting a later request.
      await withOrgContext(
        orgB,
        async (db) => {
          const rows = await db.selectFrom('locations').selectAll().execute();
          expect(rows.every((r) => r.organisation_id === orgB)).toBe(true);
        },
        isolatedPool,
      );
    } finally {
      await isolatedPool.end();
    }
  });

  it('5. concurrent requests for different organisations never cross-contaminate (stress, small pool)', async () => {
    const smallPool = attachPoolErrorHandler(
      new Pool({ connectionString: TEST_DATABASE_URL, max: 3 }),
    );
    try {
      const tasks = Array.from({ length: 30 }, (_, i) => {
        const org = i % 2 === 0 ? orgA : orgB;
        return withOrgContext(
          org,
          async (db) => {
            const rows = await db.selectFrom('locations').selectAll().execute();
            expect(rows.every((r) => r.organisation_id === org)).toBe(true);
            return org;
          },
          smallPool,
        );
      });
      const results = await Promise.all(tasks);
      expect(results.filter((r) => r === orgA)).toHaveLength(15);
      expect(results.filter((r) => r === orgB)).toHaveLength(15);
    } finally {
      await smallPool.end();
    }
  });

  it('6. nested service calls propagate the same org context to the innermost call', async () => {
    async function outerService(db: Parameters<Parameters<typeof withOrgContext>[1]>[0]) {
      return innerService(db);
    }
    async function innerService(db: Parameters<Parameters<typeof withOrgContext>[1]>[0]) {
      const ctx = await db
        .selectNoFrom((eb) =>
          eb
            .fn<string>('current_setting', [eb.val('app.current_organisation_id'), eb.val(true)])
            .as('ctx'),
        )
        .executeTakeFirst();
      return ctx?.ctx;
    }

    const seen = await withOrgContext(orgA, (db) => outerService(db), adminPool);
    expect(seen).toBe(orgA);
  });

  it('withOrgContext has no overload omitting organisationId - rejects empty/undefined at runtime', async () => {
    await expect(withOrgContext('' as any, async () => undefined, adminPool)).rejects.toThrow(
      OrgContextRequiredError,
    );
    await expect(
      withOrgContext(undefined as any, async () => undefined, adminPool),
    ).rejects.toThrow(OrgContextRequiredError);
  });
});
