import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase } from '../../test-utils/test-db';
import { withOrgContext } from '../../db/org-context';
import { attachPoolErrorHandler } from '../../db/pool';
import { PasswordResetService } from '../password-reset.service';
import { InvitationService } from '../invitation.service';
import { SessionService } from '../../sessions/session.service';
import { hashPassword, verifyPassword } from '../../security/passwords';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Password reset and invitations - single-use, expiring, hashed tokens (P0 items 14/15)',
  () => {
    let pool: Pool;
    let orgId: string;
    const passwordReset = new PasswordResetService(new SessionService());
    const invitations = new InvitationService();

    beforeAll(async () => {
      pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 5 }));
      await setUpTestDatabase(pool);
      orgId = randomUUID();
      await withOrgContext(
        orgId,
        async (db) => {
          const installation = await db
            .insertInto('installations')
            .values({ core_version: 'test', config: {} })
            .returningAll()
            .executeTakeFirstOrThrow();
          await db
            .insertInto('organisations')
            .values({
              id: orgId,
              installation_id: installation.id,
              name: 'Org',
              display_name: 'Org',
              default_currency: 'USD',
              timezone: 'UTC',
              locale: 'en-US',
              financial_year_start_month: 1,
            })
            .execute();
        },
        pool,
      );
    }, 60000);

    afterAll(async () => {
      await pool.end();
    });

    it('password reset token can be used exactly once', async () => {
      const user = await withOrgContext(
        orgId,
        async (db) =>
          db
            .insertInto('user_accounts')
            .values({
              organisation_id: orgId,
              email: 'reset@test.local',
              password_hash: await hashPassword('old-password-1'),
              is_active: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        pool,
      );

      const token = await withOrgContext(
        orgId,
        (db) => passwordReset.requestReset(db, orgId, user.id),
        pool,
      );

      await withOrgContext(
        orgId,
        (db) => passwordReset.completeReset(db, orgId, token, 'new-password-2'),
        pool,
      );

      // New password works.
      const updated = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('user_accounts')
            .selectAll()
            .where('id', '=', user.id)
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(await verifyPassword(updated.password_hash, 'new-password-2')).toBe(true);

      // Reusing the same token fails.
      await expect(
        withOrgContext(
          orgId,
          (db) => passwordReset.completeReset(db, orgId, token, 'yet-another-3'),
          pool,
        ),
      ).rejects.toThrow(/invalid, already used, or expired/i);
    });

    it('password reset token is rejected once expired', async () => {
      const user = await withOrgContext(
        orgId,
        async (db) =>
          db
            .insertInto('user_accounts')
            .values({
              organisation_id: orgId,
              email: 'expired@test.local',
              password_hash: await hashPassword('old-1'),
              is_active: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        pool,
      );

      const token = await withOrgContext(
        orgId,
        (db) => passwordReset.requestReset(db, orgId, user.id),
        pool,
      );

      // Force-expire it directly.
      await withOrgContext(
        orgId,
        (db) =>
          db
            .updateTable('password_reset_tokens')
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where('user_account_id', '=', user.id)
            .execute(),
        pool,
      );

      await expect(
        withOrgContext(
          orgId,
          (db) => passwordReset.completeReset(db, orgId, token, 'irrelevant-4'),
          pool,
        ),
      ).rejects.toThrow(/invalid, already used, or expired/i);
    });

    it('invitation token can be accepted exactly once, and the invited user sets their own password', async () => {
      const inviter = await withOrgContext(
        orgId,
        (db) =>
          db
            .insertInto('user_accounts')
            .values({
              organisation_id: orgId,
              email: 'admin1@test.local',
              password_hash: 'x',
              is_active: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        pool,
      );
      const result = await withOrgContext(
        orgId,
        (db) =>
          invitations.createInvitation(
            db,
            orgId,
            inviter.id,
            'invitee@test.local',
            [],
            false,
            'https://app.example.test',
          ),
        pool,
      );
      expect(result.invitationUrlForAdmin).toBeDefined(); // SMTP not configured -> URL surfaced to admin, per P0 item 15.

      const token = new URL(result.invitationUrlForAdmin!).searchParams.get('token')!;
      const accepted = await withOrgContext(
        orgId,
        (db) => invitations.acceptInvitation(db, orgId, token, 'my-own-chosen-password-5'),
        pool,
      );
      expect(accepted.userAccountId).toBeDefined();

      await expect(
        withOrgContext(
          orgId,
          (db) => invitations.acceptInvitation(db, orgId, token, 'second-attempt-6'),
          pool,
        ),
      ).rejects.toThrow(/invalid, already accepted, or expired/i);
    });

    it('invitation token is rejected once expired', async () => {
      const inviter = await withOrgContext(
        orgId,
        (db) =>
          db
            .insertInto('user_accounts')
            .values({
              organisation_id: orgId,
              email: 'admin2@test.local',
              password_hash: 'x',
              is_active: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        pool,
      );
      const result = await withOrgContext(
        orgId,
        (db) =>
          invitations.createInvitation(
            db,
            orgId,
            inviter.id,
            'expiredinvite@test.local',
            [],
            false,
            'https://app.example.test',
          ),
        pool,
      );
      const token = new URL(result.invitationUrlForAdmin!).searchParams.get('token')!;
      await withOrgContext(
        orgId,
        (db) =>
          db
            .updateTable('invitations')
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where('email', '=', 'expiredinvite@test.local')
            .execute(),
        pool,
      );

      await expect(
        withOrgContext(
          orgId,
          (db) => invitations.acceptInvitation(db, orgId, token, 'whatever-7'),
          pool,
        ),
      ).rejects.toThrow(/invalid, already accepted, or expired/i);
    });
  },
);
