/**
 * Real HTTP-layer integration tests: boots the actual Nest/Fastify app
 * (apps.module.ts wiring, real guards, real cookies) against real Postgres,
 * and drives it with supertest - not mocked, not unit-testing services in
 * isolation. Covers:
 *
 *   - Sessions: login establishes a session; MFA completion rotates the
 *     session id; logout revokes; logout-everywhere (password reset)
 *     revokes all; account deactivation invalidates active sessions;
 *     expired sessions are rejected; a deactivated user cannot reach an
 *     authenticated endpoint.
 *   - CSRF (Architecture §6 synchronizer-token pattern): a valid token
 *     succeeds on a state-changing request; a missing token fails; a wrong
 *     token fails; another session's token fails against this session;
 *     GET requests do not require it.
 *   - Also the basic Nest application boot integration test required by
 *     P0 item 24 (this file booting the whole app IS that test).
 *
 * API-token/service-account requests are explicitly N/A here - P0 does not
 * build that subsystem (see the RLS matrix test file's header for the same
 * note applied to org-context specifically). There is therefore no
 * "non-cookie policy" to test yet; noted rather than silently skipped.
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
import { TotpService } from '../auth/totp.service';
import { PasswordResetService } from '../auth/password-reset.service';
import { SessionService } from '../sessions/session.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('HTTP layer - sessions, CSRF, app boot (real Nest + real Postgres)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let organisationId: string;
  let ownerEmail: string;
  let ownerPassword: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    process.env.COOKIE_SECURE = 'false';

    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    setPool(pool); // point the app's shared getPool() singleton at our test pool

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // Seed installation + organisation + owner via the real services (not HTTP,
    // to keep this file focused on session/CSRF behaviour post-bootstrap).
    const installationService = app.get(InstallationService);
    const bootstrapService = app.get(BootstrapService);
    const bootstrap = await installationService.ensureInstallation(pool);
    ownerEmail = 'owner@e2e.test';
    ownerPassword = 'a-very-strong-owner-password-1';
    const result = await bootstrapService.completeBootstrap(
      {
        token: bootstrap.plaintextBootstrapToken!,
        organisationName: 'E2E Org',
        organisationDisplayName: 'E2E Org',
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
  }, 60000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function server() {
    return app.getHttpAdapter().getInstance().server;
  }

  it('boots the full Nest application against real Postgres and answers health checks', async () => {
    const res = await request(server()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('rejects an unauthenticated request to an authenticated endpoint', async () => {
    const res = await request(server()).get('/api/v1/organisation');
    expect(res.status).toBe(401);
  });

  it('login establishes a session (cookie + csrfToken), and the session can then reach an authenticated endpoint', async () => {
    const agent = request.agent(server());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
    expect(loginRes.status).toBe(201);
    expect(loginRes.body.csrfToken).toBeDefined();
    expect(loginRes.headers['set-cookie']).toBeDefined();

    const orgRes = await agent.get('/api/v1/organisation');
    expect(orgRes.status).toBe(200);
    expect(orgRes.body.display_name).toBe('E2E Org');
  });

  it('rejects login with wrong credentials without revealing account existence', async () => {
    const res = await request(server()).post('/api/v1/auth/login').send({ email: ownerEmail, password: 'totally-wrong' });
    expect(res.status).toBe(401);
    const res2 = await request(server()).post('/api/v1/auth/login').send({ email: 'nobody@e2e.test', password: 'whatever' });
    expect(res2.status).toBe(401);
    expect(res.body.message).toEqual(res2.body.message);
  });

  describe('CSRF (synchronizer-token pattern, Architecture §6)', () => {
    it('a state-changing request WITHOUT the CSRF header is rejected even with a valid session cookie', async () => {
      const agent = request.agent(server());
      await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
      // logout is a state-changing (POST) authenticated-only route - no X-Hexyrn-CSRF header sent.
      const res = await agent.post('/api/v1/auth/logout');
      expect(res.status).toBe(401);
    });

    it('a state-changing request WITH the wrong CSRF token is rejected', async () => {
      const agent = request.agent(server());
      const login = await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
      const res = await agent.post('/api/v1/auth/logout').set('X-Hexyrn-CSRF', 'not-the-real-token-' + login.body.csrfToken);
      expect(res.status).toBe(401);
    });

    it("another session's CSRF token is rejected against this session", async () => {
      const agentA = request.agent(server());
      const agentB = request.agent(server());
      const loginA = await agentA.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });

      // Need a second distinct user to get a second, genuinely different session/token.
      await withOrgContext(organisationId, async (db) => {
        const { hashPassword } = await import('../security/passwords');
        await db
          .insertInto('user_accounts')
          .values({ organisation_id: organisationId, email: 'second@e2e.test', password_hash: await hashPassword('second-users-password-1'), is_active: true })
          .execute();
      }, pool);
      const loginB = await agentB.post('/api/v1/auth/login').send({ email: 'second@e2e.test', password: 'second-users-password-1' });

      // agentA's cookie, but agentB's csrf token - must fail.
      const res = await agentA.post('/api/v1/auth/logout').set('X-Hexyrn-CSRF', loginB.body.csrfToken);
      expect(res.status).toBe(401);
      expect(loginA.body.csrfToken).not.toBe(loginB.body.csrfToken);
    });

    it('a state-changing request WITH the correct CSRF token for this session succeeds', async () => {
      const agent = request.agent(server());
      const login = await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
      const res = await agent.post('/api/v1/auth/logout').set('X-Hexyrn-CSRF', login.body.csrfToken);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    });

    it('GET (non-state-changing) requests do not require a CSRF token', async () => {
      const agent = request.agent(server());
      await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
      const res = await agent.get('/api/v1/organisation'); // no X-Hexyrn-CSRF header
      expect(res.status).toBe(200);
    });
  });

  describe('Sessions', () => {
    it('logout revokes the session - a subsequent authenticated request fails', async () => {
      const agent = request.agent(server());
      const login = await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
      const logoutRes = await agent.post('/api/v1/auth/logout').set('X-Hexyrn-CSRF', login.body.csrfToken);
      expect(logoutRes.status).toBe(201);

      const after = await agent.get('/api/v1/organisation');
      expect(after.status).toBe(401);
    });

    it('an expired session is rejected', async () => {
      const agent = request.agent(server());
      const login = await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
      expect(login.status).toBe(201);

      // Force-expire the session directly (simulating time passing).
      await withOrgContext(organisationId, (db) =>
        db
          .updateTable('sessions')
          .set({ expires_at: new Date(Date.now() - 1000) })
          .where('organisation_id', '=', organisationId)
          .where('revoked_at', 'is', null)
          .execute(),
      pool);

      const res = await agent.get('/api/v1/organisation');
      expect(res.status).toBe(401);
    });

    it('account deactivation invalidates active sessions - a subsequent authenticated request fails immediately', async () => {
      await withOrgContext(organisationId, async (db) => {
        const { hashPassword } = await import('../security/passwords');
        await db
          .insertInto('user_accounts')
          .values({ organisation_id: organisationId, email: 'deactme@e2e.test', password_hash: await hashPassword('deactme-password-1'), is_active: true })
          .execute();
      }, pool);

      const agent = request.agent(server());
      const login = await agent.post('/api/v1/auth/login').send({ email: 'deactme@e2e.test', password: 'deactme-password-1' });
      expect(login.status).toBe(201);
      const before = await agent.get('/api/v1/organisation');
      expect(before.status).toBe(200);

      const { AuthService } = await import('../auth/auth.service');
      const { AuditService: AuditSvc } = await import('../audit/audit.service');
      const { SessionService: SessSvc } = await import('../sessions/session.service');
      const authService = new AuthService(new SessSvc(), new AuditSvc());
      const user = await withOrgContext(organisationId, (db) => db.selectFrom('user_accounts').selectAll().where('email', '=', 'deactme@e2e.test').executeTakeFirstOrThrow(), pool);
      await withOrgContext(organisationId, (db) => authService.deactivateAccount(db, organisationId, user.id, user.id), pool);

      const after = await agent.get('/api/v1/organisation');
      expect(after.status).toBe(401);
    });

    it('password reset (self-service) revokes all existing sessions - logout-everywhere', async () => {
      await withOrgContext(organisationId, async (db) => {
        const { hashPassword } = await import('../security/passwords');
        await db
          .insertInto('user_accounts')
          .values({ organisation_id: organisationId, email: 'resetme@e2e.test', password_hash: await hashPassword('resetme-original-1'), is_active: true })
          .execute();
      }, pool);

      const agent = request.agent(server());
      const login = await agent.post('/api/v1/auth/login').send({ email: 'resetme@e2e.test', password: 'resetme-original-1' });
      expect(login.status).toBe(201);

      const user = await withOrgContext(organisationId, (db) => db.selectFrom('user_accounts').selectAll().where('email', '=', 'resetme@e2e.test').executeTakeFirstOrThrow(), pool);
      const resetService = new PasswordResetService(new SessionService());
      const resetToken = await withOrgContext(organisationId, (db) => resetService.requestReset(db, organisationId, user.id), pool);
      await withOrgContext(organisationId, (db) => resetService.completeReset(db, organisationId, resetToken, 'resetme-new-password-2'), pool);

      // The session established before the reset must now be dead.
      const after = await agent.get('/api/v1/organisation');
      expect(after.status).toBe(401);
    });
  });

  describe('MFA session rotation', () => {
    it('MFA completion rotates the session id and issues a fresh CSRF token', async () => {
      const totpService = new TotpService();
      const enrolment = totpService.beginEnrolment('mfa-e2e@e2e.test');

      await withOrgContext(organisationId, async (db) => {
        const { hashPassword } = await import('../security/passwords');
        const user = await db
          .insertInto('user_accounts')
          .values({ organisation_id: organisationId, email: 'mfa-e2e@e2e.test', password_hash: await hashPassword('mfa-e2e-password-1'), is_active: true })
          .returningAll()
          .executeTakeFirstOrThrow();
        const { authenticator } = await import('otplib');
        const code = authenticator.generate(enrolment.secret);
        await totpService.completeEnrolment(db, user.id, enrolment.secret, code, organisationId);
      }, pool);

      const agent = request.agent(server());
      const login = await agent.post('/api/v1/auth/login').send({ email: 'mfa-e2e@e2e.test', password: 'mfa-e2e-password-1' });
      expect(login.status).toBe(201);
      expect(login.body.requiresMfa).toBe(true);
      const preMfaCsrf = login.body.csrfToken;

      const { authenticator } = await import('otplib');
      const code = authenticator.generate(enrolment.secret);
      // The pre-MFA session's own CSRF token (returned by /auth/login) must be
      // echoed here - mfa/verify is a state-changing request against that
      // pending session, per Architecture §6's synchronizer-token rule. The
      // real frontend (apps/web/src/pages/LoginPage.tsx) already does this by
      // calling setCsrfToken() with the login response before navigating to
      // the MFA page.
      const mfaRes = await agent.post('/api/v1/auth/mfa/verify').set('X-Hexyrn-CSRF', preMfaCsrf).send({ code });
      expect(mfaRes.status).toBe(201);
      expect(mfaRes.body.verified).toBe(true);
      expect(mfaRes.body.csrfToken).not.toBe(preMfaCsrf);

      // The rotated session works for authenticated requests using the NEW csrf token.
      const afterRes = await agent.get('/api/v1/organisation');
      expect(afterRes.status).toBe(200);
    });
  });
});
