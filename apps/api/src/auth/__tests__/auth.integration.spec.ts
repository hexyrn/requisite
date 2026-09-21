import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase } from '../../test-utils/test-db';
import { withOrgContext } from '../../db/org-context';
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
    return withOrgContext(orgId, async (db) => {
      const passwordHash = await hashPassword(password);
      return db
        .insertInto('user_accounts')
        .values({ organisation_id: orgId, email, password_hash: passwordHash, is_active: true })
        .returningAll()
        .executeTakeFirstOrThrow();
    }, pool);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    await setUpTestDatabase(pool);
    orgId = randomUUID();
    await withOrgContext(orgId, async (db) => {
      const installation = await db.insertInto('installations').values({ core_version: 'test', config: {} }).returningAll().executeTakeFirstOrThrow();
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
    }, pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('logs in successfully with correct credentials and creates a session', async () => {
    await createUser('alice@test.local', 'correct-horse-battery-staple');
    const result = await withOrgContext(orgId, (db) => auth.login(db, orgId, 'alice@test.local', 'correct-horse-battery-staple'), pool);
    expect(result.session.id).toBeDefined();
    expect(result.requiresMfa).toBe(false);
  });

  it('rejects wrong password without revealing whether the account exists', async () => {
    await createUser('bob@test.local', 'the-real-password-1');
    await expect(
      withOrgContext(orgId, (db) => auth.login(db, orgId, 'bob@test.local', 'wrong-password'), pool),
    ).rejects.toThrow(/invalid email or password/i);
    await expect(
      withOrgContext(orgId, (db) => auth.login(db, orgId, 'nobody@test.local', 'whatever'), pool),
    ).rejects.toThrow(/invalid email or password/i);
  });

  it('locks the account out after repeated failed attempts (brute-force lockout)', async () => {
    await createUser('carol@test.local', 'the-real-password-2');
    for (let i = 0; i < 5; i++) {
      await expect(
        withOrgContext(orgId, (db) => auth.login(db, orgId, 'carol@test.local', 'wrong'), pool),
      ).rejects.toThrow();
    }
    // Even the correct password is now rejected while locked.
    await expect(
      withOrgContext(orgId, (db) => auth.login(db, orgId, 'carol@test.local', 'the-real-password-2'), pool),
    ).rejects.toThrow(/locked/i);
  });

  it('REQUIRED: account deactivation immediately invalidates all active sessions for that user', async () => {
    const user = await createUser('dave@test.local', 'yet-another-strong-password');
    const login1 = await withOrgContext(orgId, (db) => auth.login(db, orgId, 'dave@test.local', 'yet-another-strong-password'), pool);
    const login2 = await withOrgContext(orgId, (db) => auth.login(db, orgId, 'dave@test.local', 'yet-another-strong-password'), pool);

    // Both sessions active beforehand.
    await withOrgContext(orgId, async (db) => {
      expect(await sessionService.getActiveSession(db, login1.session.id)).toBeDefined();
      expect(await sessionService.getActiveSession(db, login2.session.id)).toBeDefined();
    }, pool);

    await withOrgContext(orgId, (db) => auth.deactivateAccount(db, orgId, user.id, user.id), pool);

    await withOrgContext(orgId, async (db) => {
      expect(await sessionService.getActiveSession(db, login1.session.id)).toBeUndefined();
      expect(await sessionService.getActiveSession(db, login2.session.id)).toBeUndefined();
    }, pool);

    // And login is now rejected outright.
    await expect(
      withOrgContext(orgId, (db) => auth.login(db, orgId, 'dave@test.local', 'yet-another-strong-password'), pool),
    ).rejects.toThrow(/deactivated/i);
  });
});
