import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase } from '../../test-utils/test-db';
import { withOrgContext } from '../../db/org-context';
import { attachPoolErrorHandler } from '../../db/pool';
import { AuthService } from '../auth.service';
import { SessionService } from '../../sessions/session.service';
import { AuditService } from '../../audit/audit.service';
import { hashPassword } from '../../security/passwords';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('AuthService - login, lockout, sessions, deactivation (P0 items 12/13)', () => {
  let pool: Pool;
  let orgId: string;
  const sessionService = new SessionService();
  const audit = new AuditService();
  const auth = new AuthService(sessionService, audit);

  async function createUser(email: string, password: string) {
    return withOrgContext(
      orgId,
      async (db) => {
        const passwordHash = await hashPassword(password);
        return db
          .insertInto('user_accounts')
          .values({ organisation_id: orgId, email, password_hash: passwordHash, is_active: true })
          .returningAll()
          .executeTakeFirstOrThrow();
      },
      pool,
    );
  }

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
            name: 'Test Org',
            display_name: 'Test Org',
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

  it('logs in successfully with correct credentials and creates a session', async () => {
    await createUser('alice@test.local', 'correct-horse-battery-staple');
    const outcome = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'alice@test.local', 'correct-horse-battery-staple'),
      pool,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.session.id).toBeDefined();
    expect(outcome.requiresMfa).toBe(false);
  });

  it('rejects wrong password without revealing whether the account exists, and both are audited', async () => {
    await createUser('bob@test.local', 'the-real-password-1');
    const wrongPw = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'bob@test.local', 'wrong-password'),
      pool,
    );
    const noAccount = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'nobody@test.local', 'whatever'),
      pool,
    );
    expect(wrongPw).toEqual({ ok: false, reason: 'bad-password' });
    expect(noAccount).toEqual({ ok: false, reason: 'unknown-account' });

    // REQUIRED: failed logins must actually be persisted to the audit trail
    // (P0 item 21). This is exactly the bug found via real-Postgres testing:
    // AuthService used to throw inside the org-context transaction, which
    // correctly rolled back per Architecture §8 - silently discarding this
    // audit write every time. Asserting it here proves the fix holds.
    const events = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('audit_events')
          .selectAll()
          .where('event_type', '=', 'auth.login.failed')
          .execute(),
      pool,
    );
    expect(events.some((e) => (e.metadata as any).reason === 'bad-password')).toBe(true);
    expect(events.some((e) => (e.metadata as any).reason === 'unknown-account')).toBe(true);
  });

  it('locks the account out after repeated failed attempts (brute-force lockout), and the counter actually persists', async () => {
    const user = await createUser('carol@test.local', 'the-real-password-2');
    for (let i = 0; i < 5; i++) {
      const outcome = await withOrgContext(
        orgId,
        (db) => auth.login(db, orgId, 'carol@test.local', 'wrong'),
        pool,
      );
      expect(outcome.ok).toBe(false);
    }

    const row = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('user_accounts')
          .selectAll()
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow(),
      pool,
    );
    expect(row.failed_login_count).toBe(5);
    expect(row.locked_until).not.toBeNull();

    // Even the correct password is now rejected while locked.
    const outcome = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'carol@test.local', 'the-real-password-2'),
      pool,
    );
    expect(outcome).toEqual({ ok: false, reason: 'locked' });
  });

  it('a successful login resets the failed-attempt counter', async () => {
    await createUser('erin@test.local', 'erins-strong-password-1');
    await withOrgContext(orgId, (db) => auth.login(db, orgId, 'erin@test.local', 'wrong'), pool);
    await withOrgContext(orgId, (db) => auth.login(db, orgId, 'erin@test.local', 'wrong'), pool);
    const outcome = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'erin@test.local', 'erins-strong-password-1'),
      pool,
    );
    expect(outcome.ok).toBe(true);

    const row = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('user_accounts')
          .selectAll()
          .where('email', '=', 'erin@test.local')
          .executeTakeFirstOrThrow(),
      pool,
    );
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it('REQUIRED: account deactivation immediately invalidates all active sessions for that user, and a deactivated user cannot log in', async () => {
    const user = await createUser('dave@test.local', 'yet-another-strong-password');
    const login1 = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'dave@test.local', 'yet-another-strong-password'),
      pool,
    );
    const login2 = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'dave@test.local', 'yet-another-strong-password'),
      pool,
    );
    if (!login1.ok || !login2.ok) throw new Error('setup failed');

    // Both sessions active beforehand.
    await withOrgContext(
      orgId,
      async (db) => {
        expect(await sessionService.getActiveSession(db, login1.session.id)).toBeDefined();
        expect(await sessionService.getActiveSession(db, login2.session.id)).toBeDefined();
      },
      pool,
    );

    await withOrgContext(orgId, (db) => auth.deactivateAccount(db, orgId, user.id, user.id), pool);

    await withOrgContext(
      orgId,
      async (db) => {
        expect(await sessionService.getActiveSession(db, login1.session.id)).toBeUndefined();
        expect(await sessionService.getActiveSession(db, login2.session.id)).toBeUndefined();
      },
      pool,
    );

    // And login is now rejected outright.
    const outcome = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'dave@test.local', 'yet-another-strong-password'),
      pool,
    );
    expect(outcome).toEqual({ ok: false, reason: 'inactive' });
  });

  it('password change rotates the session (revokes all existing, issues one fresh mfa-verified session)', async () => {
    const user = await createUser('frank@test.local', 'franks-original-password');
    const login1 = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'frank@test.local', 'franks-original-password'),
      pool,
    );
    if (!login1.ok) throw new Error('setup failed');

    const newSession = await withOrgContext(
      orgId,
      (db) => auth.changePassword(db, orgId, user.id, 'franks-new-password'),
      pool,
    );
    expect(newSession.id).not.toBe(login1.session.id);

    await withOrgContext(
      orgId,
      async (db) => {
        expect(await sessionService.getActiveSession(db, login1.session.id)).toBeUndefined();
        expect(await sessionService.getActiveSession(db, newSession.id)).toBeDefined();
      },
      pool,
    );

    // Old password no longer works; new one does.
    const oldPwOutcome = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'frank@test.local', 'franks-original-password'),
      pool,
    );
    expect(oldPwOutcome.ok).toBe(false);
    const newPwOutcome = await withOrgContext(
      orgId,
      (db) => auth.login(db, orgId, 'frank@test.local', 'franks-new-password'),
      pool,
    );
    expect(newPwOutcome.ok).toBe(true);
  });
});
