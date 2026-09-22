/**
 * Real HTTP-layer tests for the password-reset and invitation controllers
 * (P0 items 14/15), plus proof that account-based rate limiting (P0
 * technical-debt item 4B) actually engages over real HTTP, not just at the
 * unit level (see account-rate-limiter.spec.ts for the limiter's own unit
 * tests). Uses the password-reset/request endpoint for the rate-limit proof
 * specifically because, unlike login, it has no other competing lockout
 * mechanism to mask the 429 behind a different status code.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../app.module';
import { setUpTestDatabase } from '../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../db/pool';
import { withOrgContext } from '../db/org-context';
import { InstallationService } from '../bootstrap/installation.service';
import { BootstrapService } from '../bootstrap/bootstrap.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Password reset / invitation controllers + rate limiting (real HTTP + real Postgres)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let organisationId: string;
  let ownerEmail: string;
  let ownerPassword: string;
  let ownerCsrf: string;
  let agentOwner: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    process.env.COOKIE_SECURE = 'false';

    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    setPool(pool);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const installationService = app.get(InstallationService);
    const bootstrapService = app.get(BootstrapService);
    const bootstrap = await installationService.ensureInstallation(pool);
    ownerEmail = 'owner@rl.test';
    ownerPassword = 'owner-rate-limit-password-1';
    const result = await bootstrapService.completeBootstrap(
      {
        token: bootstrap.plaintextBootstrapToken!,
        organisationName: 'RL Org',
        organisationDisplayName: 'RL Org',
        defaultCurrency: 'USD',
        timezone: 'UTC',
        locale: 'en-US',
        financialYearStartMonth: 1,
        ownerEmail,
        ownerPassword,
      },
      pool,
    );
    organisationId = result.organisationId;

    agentOwner = request.agent(server());
    const login = await agentOwner.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
    ownerCsrf = login.body.csrfToken;
  }, 60000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function server() {
    return app.getHttpAdapter().getInstance().server;
  }

  it('password reset: request always returns { ok: true } regardless of account existence (no enumeration)', async () => {
    const known = await request(server()).post('/api/v1/auth/password-reset/request').send({ email: ownerEmail });
    const unknown = await request(server()).post('/api/v1/auth/password-reset/request').send({ email: 'nobody-at-all@rl.test' });
    expect(known.status).toBe(201);
    expect(unknown.status).toBe(201);
    expect(known.body).toEqual({ ok: true });
    expect(unknown.body).toEqual({ ok: true });
  });

  it('password reset: never returns the token/URL in the HTTP response body', async () => {
    const res = await request(server()).post('/api/v1/auth/password-reset/request').send({ email: ownerEmail });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/reset-password/i);
  });

  it('password reset: full flow works via the real token, and it is single-use', async () => {
    await withOrgContext(organisationId, async (db) => {
      const { hashPassword } = await import('../security/passwords');
      await db.insertInto('user_accounts').values({ organisation_id: organisationId, email: 'resetflow@rl.test', password_hash: await hashPassword('resetflow-original-1'), is_active: true }).execute();
    }, pool);

    const { PasswordResetService } = await import('../auth/password-reset.service');
    const { SessionService } = await import('../sessions/session.service');
    const resetService = new PasswordResetService(new SessionService());
    const user = await withOrgContext(organisationId, (db) => db.selectFrom('user_accounts').selectAll().where('email', '=', 'resetflow@rl.test').executeTakeFirstOrThrow(), pool);
    const token = await withOrgContext(organisationId, (db) => resetService.requestReset(db, organisationId, user.id), pool);

    const submit = await request(server()).post('/api/v1/auth/password-reset/submit').send({ token, newPassword: 'resetflow-new-2' });
    expect(submit.status).toBe(201);

    const reuse = await request(server()).post('/api/v1/auth/password-reset/submit').send({ token, newPassword: 'resetflow-new-3' });
    expect(reuse.status).toBe(400);

    const loginOld = await request(server()).post('/api/v1/auth/login').send({ email: 'resetflow@rl.test', password: 'resetflow-original-1' });
    expect(loginOld.status).toBe(401);
    const loginNew = await request(server()).post('/api/v1/auth/login').send({ email: 'resetflow@rl.test', password: 'resetflow-new-2' });
    expect(loginNew.status).toBe(201);
  });

  it('password reset: account-based rate limiting engages after the configured threshold (429)', async () => {
    // passwordResetRequestRateLimiters.byAccount allows 5 per hour, per src/security/rate-limits.ts.
    const email = 'rl-target@rl.test';
    let sawTooMany = false;
    for (let i = 0; i < 8; i++) {
      const res = await request(server()).post('/api/v1/auth/password-reset/request').send({ email });
      if (res.status === 429) {
        sawTooMany = true;
        break;
      }
      expect(res.status).toBe(201);
    }
    expect(sawTooMany).toBe(true);
  });

  it('SECURITY: cannot invite a user into a role that grants permissions the inviter does not hold', async () => {
    // Create a "Limited Admin" role that holds only users.manage (not the
    // full Owner permission set), assign it to a fresh user, and prove that
    // user cannot use their users.manage permission to invite someone into
    // the (more powerful) Owner role.
    const { CORE_PERMISSIONS } = await import('../rbac/permissions');
    const limitedRole = await withOrgContext(organisationId, async (db) => {
      const role = await db.insertInto('roles').values({ organisation_id: organisationId, name: 'Limited Admin' }).returningAll().executeTakeFirstOrThrow();
      await db.insertInto('role_permissions').values({ organisation_id: organisationId, role_id: role.id, permission_key: CORE_PERMISSIONS.USERS_MANAGE }).execute();
      return role;
    }, pool);

    const ownerRole = await withOrgContext(organisationId, (db) => db.selectFrom('roles').selectAll().where('organisation_id', '=', organisationId).where('name', '=', 'Owner').executeTakeFirstOrThrow(), pool);

    const limitedUser = await withOrgContext(organisationId, async (db) => {
      const { hashPassword } = await import('../security/passwords');
      const user = await db.insertInto('user_accounts').values({ organisation_id: organisationId, email: 'limited-admin@rl.test', password_hash: await hashPassword('limited-admin-password-1'), is_active: true }).returningAll().executeTakeFirstOrThrow();
      await db.insertInto('user_roles').values({ organisation_id: organisationId, user_account_id: user.id, role_id: limitedRole.id }).execute();
      return user;
    }, pool);
    void limitedUser;

    const agent = request.agent(server());
    const login = await agent.post('/api/v1/auth/login').send({ email: 'limited-admin@rl.test', password: 'limited-admin-password-1' });
    expect(login.status).toBe(201);

    // This user DOES hold users.manage, so the permission guard lets them in -
    // but the privilege-escalation check must still block granting Owner.
    const escalate = await agent.post('/api/v1/auth/invitations').set('X-Hexyrn-CSRF', login.body.csrfToken).send({ email: 'escalated@rl.test', roleIds: [ownerRole.id] });
    expect(escalate.status).toBe(403);

    // Granting their OWN role (a subset of their own permissions) is fine.
    const legit = await agent.post('/api/v1/auth/invitations').set('X-Hexyrn-CSRF', login.body.csrfToken).send({ email: 'legit-invite@rl.test', roleIds: [limitedRole.id] });
    expect(legit.status).toBe(201);
  });

  it('invitation: an authenticated admin can create one and gets the URL back directly (SMTP not configured)', async () => {
    const res = await agentOwner.post('/api/v1/auth/invitations').set('X-Hexyrn-CSRF', ownerCsrf).send({ email: 'invitee-http@rl.test' });
    expect(res.status).toBe(201);
    expect(res.body.invitationUrlForAdmin).toContain('/setup/accept-invitation?token=');
  });

  it('invitation: creating one without the required permission is rejected', async () => {
    await withOrgContext(organisationId, async (db) => {
      const { hashPassword } = await import('../security/passwords');
      await db.insertInto('user_accounts').values({ organisation_id: organisationId, email: 'noperm@rl.test', password_hash: await hashPassword('noperm-password-1'), is_active: true }).execute();
    }, pool);
    const agent = request.agent(server());
    const login = await agent.post('/api/v1/auth/login').send({ email: 'noperm@rl.test', password: 'noperm-password-1' });
    const res = await agent.post('/api/v1/auth/invitations').set('X-Hexyrn-CSRF', login.body.csrfToken).send({ email: 'someone@rl.test' });
    expect(res.status).toBe(403);
  });

  it('invitation: accept works via HTTP, is single-use, and the invited user can then log in', async () => {
    const createRes = await agentOwner.post('/api/v1/auth/invitations').set('X-Hexyrn-CSRF', ownerCsrf).send({ email: 'accepthttp@rl.test' });
    const token = new URL(createRes.body.invitationUrlForAdmin, 'http://placeholder').searchParams.get('token')!;

    const accept = await request(server()).post('/api/v1/auth/invitations/accept').send({ token, password: 'accepthttp-password-1' });
    expect(accept.status).toBe(201);
    expect(accept.body.userAccountId).toBeDefined();

    const reuse = await request(server()).post('/api/v1/auth/invitations/accept').send({ token, password: 'different-2' });
    expect(reuse.status).toBe(400);

    const login = await request(server()).post('/api/v1/auth/login').send({ email: 'accepthttp@rl.test', password: 'accepthttp-password-1' });
    expect(login.status).toBe(201);
  });
});
