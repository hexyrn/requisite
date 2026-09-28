import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../test-utils/test-db';
import { attachPoolErrorHandler } from '../../db/pool';
import { withOrgContext } from '../../db/org-context';
import { hashPassword, verifyPassword } from '../../security/passwords';
import { resetPassword } from '../reset-password';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

/** The real tool connects as the BYPASSRLS backup role; the test database's role is subject to RLS, so scope it to the org instead. */
function scoped(pool: Pool, orgId: string): Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      await client.query(`SELECT set_config('app.current_organisation_id', $1, false)`, [orgId]);
      return client;
    },
  } as unknown as Pool;
}

describeIfDb('offline password reset tool', () => {
  let pool: Pool;
  let orgId: string;
  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 4 }));
    await setUpTestDatabase(pool);
    orgId = await createTestOrg(pool, 'Reset Org');
    await withOrgContext(
      orgId,
      async (db) => {
        const u = await db
          .insertInto('user_accounts')
          .values({
            organisation_id: orgId,
            email: 'Locked@Reset.Test',
            password_hash: await hashPassword('old-password-123456'),
            failed_login_count: 7,
            locked_until: new Date(Date.now() + 3600_000),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await db
          .insertInto('sessions')
          .values({
            organisation_id: orgId,
            user_account_id: u.id,
            csrf_token: 'x',
            expires_at: new Date(Date.now() + 3600_000),
          })
          .execute();
      },
      pool,
    );
  });
  afterAll(async () => pool.end());

  it('sets the new password (case-insensitive email), clears the lock-out and signs out sessions', async () => {
    expect(
      await resetPassword(scoped(pool, orgId), 'locked@reset.test', 'a-brand-new-password-1'),
    ).toBe(true);
    const client = await pool.connect();
    await client.query(`SELECT set_config('app.current_organisation_id', $1, false)`, [orgId]);
    const row = await client.query(
      `SELECT password_hash, failed_login_count, locked_until,
              (SELECT count(*) FROM sessions s WHERE s.user_account_id = u.id AND s.revoked_at IS NULL) AS live
         FROM user_accounts u WHERE lower(email) = 'locked@reset.test'`,
    );
    client.release();
    expect(await verifyPassword(row.rows[0].password_hash, 'a-brand-new-password-1')).toBe(true);
    expect(row.rows[0].failed_login_count).toBe(0);
    expect(row.rows[0].locked_until).toBeNull();
    expect(Number(row.rows[0].live)).toBe(0);
  });

  it('reports an unknown account and refuses a weak password', async () => {
    expect(
      await resetPassword(scoped(pool, orgId), 'nobody@reset.test', 'a-brand-new-password-1'),
    ).toBe(false);
    await expect(resetPassword(scoped(pool, orgId), 'locked@reset.test', 'short')).rejects.toThrow(
      /12 characters/,
    );
  });
});
