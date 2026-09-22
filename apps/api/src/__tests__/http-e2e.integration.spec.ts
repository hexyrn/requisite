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
    const loginRes = await agent
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password: ownerPassword });
    expect(loginRes.status).toBe(201);
    expect(loginRes.body.csrfToken).toBeDefined();
    expect(loginRes.headers['set-cookie']).toBeDefined();

    const orgRes = await agent.get('/api/v1/organisation');
    expect(orgRes.status).toBe(200);
    expect(orgRes.body.display_name).toBe('E2E Org');
  });

  it('rejects login with wrong credentials without revealing account existence', async () => {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password: 'totally-wrong' });
    expect(res.status).toBe(401);
    const res2 = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@e2e.test', password: 'whatever' });
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
      const login = await agent
        .post('/api/v1/auth/login')
        .send({ email: ownerEmail, password: ownerPassword });
      const res = await agent
        .post('/api/v1/auth/logout')
        .set('X-Hexyrn-CSRF', 'not-the-real-token-' + login.body.csrfToken);
      expect(res.status).toBe(401);
    });

    it("another session's CSRF token is rejected against this session", async () => {
      const agentA = request.agent(server());
      const agentB = request.agent(server());
      const loginA = await agentA
        .post('/api/v1/auth/login')
        .send({ email: ownerEmail, password: ownerPassword });

      // Need a second distinct user to get a second, genuinely different session/token.
      await withOrgContext(
        organisationId,
        async (db) => {
          const { hashPassword } = await import('../security/passwords');
          await db
            .insertInto('user_accounts')
            .values({
              organisation_id: organisationId,
              email: 'second@e2e.test',
              password_hash: await hashPassword('second-users-password-1'),
              is_active: true,
            })
            .execute();
        },
        pool,
      );
      const loginB = await agentB
        .post('/api/v1/auth/login')
        .send({ email: 'second@e2e.test', password: 'second-users-password-1' });

      // agentA's cookie, but agentB's csrf token - must fail.
      const res = await agentA
        .post('/api/v1/auth/logout')
        .set('X-Hexyrn-CSRF', loginB.body.csrfToken);
      expect(res.status).toBe(401);
      expect(loginA.body.csrfToken).not.toBe(loginB.body.csrfToken);
    });

    it('a state-changing request WITH the correct CSRF token for this session succeeds', async () => {
      const agent = request.agent(server());
      const login = await agent
        .post('/api/v1/auth/login')
        .send({ email: ownerEmail, password: ownerPassword });
      const res = await agent
        .post('/api/v1/auth/logout')
        .set('X-Hexyrn-CSRF', login.body.csrfToken);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    });

    it('GET (non-state-changing) requests do not require a CSRF token', async () => {
      const agent = request.agent(server());
      await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
      const res = await agent.get('/api/v1/organisation'); // no X-Hexyrn-CSRF header
      expect(res.status).toBe(200);
    });

    // Regression test for a real bug found during Requisite UI manual testing
    // (2026-09-22): SessionAuthGuard applied the CSRF check to @PublicRoute()
    // handlers too whenever a still-valid session cookie happened to be
    // present, so a logged-in user re-submitting the login form (e.g. a
    // second browser tab, or returning to /login without logging out first)
    // got "Missing or invalid CSRF token" even though the login form has no
    // CSRF token to send yet - login isn't behind the synchronizer-token
    // gate at all, by design (PUBLIC_ROUTE_KEY). Fixed by excluding
    // @PublicRoute() handlers from the CSRF check regardless of session state.
    // Uses the dedicated 'second@e2e.test' user (created by the "another
    // session's CSRF token" test above, which always runs first within this
    // describe block) rather than ownerEmail specifically so these two new
    // tests don't add to ownerEmail's already-heavily-used share of the
    // account rate limiter's per-15-minute budget (loginRateLimiters.byAccount,
    // security/rate-limits.ts) - that budget is shared, module-level, and
    // consumed by every login in this file, so tests intentionally spread
    // their login calls across distinct accounts where the account identity
    // itself isn't the thing under test.
    it('re-submitting login while an existing valid session cookie is present succeeds without a CSRF header (public route, regression)', async () => {
      const agent = request.agent(server());
      const first = await agent
        .post('/api/v1/auth/login')
        .send({ email: 'second@e2e.test', password: 'second-users-password-1' });
      expect(first.status).toBe(201);

      // Same agent (same session cookie jar) hits POST /auth/login again -
      // a @PublicRoute() - with no X-Hexyrn-CSRF header. Must succeed, not 401.
      const second = await agent
        .post('/api/v1/auth/login')
        .send({ email: 'second@e2e.test', password: 'second-users-password-1' });
      expect(second.status).toBe(201);
      expect(second.body.csrfToken).toBeDefined();
    });

    // Companion test proving the fix did NOT weaken CSRF protection for any
    // genuinely authenticated, non-public, state-changing route: it must
    // still reject a missing CSRF header exactly as before.
    it('a non-public authenticated mutating route still requires CSRF even after the public-route fix', async () => {
      const agent = request.agent(server());
      await agent.post('/api/v1/auth/login').send({ email: 'second@e2e.test', password: 'second-users-password-1' });
      const res = await agent.post('/api/v1/auth/logout'); // logout is NOT @PublicRoute() - no header sent
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/CSRF/i);
    });
  });

  describe('Sessions', () => {
    it('logout revokes the session - a subsequent authenticated request fails', async () => {
      const agent = request.agent(server());
      const login = await agent
        .post('/api/v1/auth/login')
        .send({ email: ownerEmail, password: ownerPassword });
      const logoutRes = await agent
        .post('/api/v1/auth/logout')
        .set('X-Hexyrn-CSRF', login.body.csrfToken);
      expect(logoutRes.status).toBe(201);

      const after = await agent.get('/api/v1/organisation');
      expect(after.status).toBe(401);
    });

    it('an expired session is rejected', async () => {
      const agent = request.agent(server());
      const login = await agent
        .post('/api/v1/auth/login')
        .send({ email: ownerEmail, password: ownerPassword });
      expect(login.status).toBe(201);

      // Force-expire the session directly (simulating time passing).
      await withOrgContext(
        organisationId,
        (db) =>
          db
            .updateTable('sessions')
            .set({ expires_at: new Date(Date.now() - 1000) })
            .where('organisation_id', '=', organisationId)
            .where('revoked_at', 'is', null)
            .execute(),
        pool,
      );

      const res = await agent.get('/api/v1/organisation');
      expect(res.status).toBe(401);
    });

    it('account deactivation invalidates active sessions - a subsequent authenticated request fails immediately', async () => {
      await withOrgContext(
        organisationId,
        async (db) => {
          const { hashPassword } = await import('../security/passwords');
          await db
            .insertInto('user_accounts')
            .values({
              organisation_id: organisationId,
              email: 'deactme@e2e.test',
              password_hash: await hashPassword('deactme-password-1'),
              is_active: true,
            })
            .execute();
        },
        pool,
      );

      const agent = request.agent(server());
      const login = await agent
        .post('/api/v1/auth/login')
        .send({ email: 'deactme@e2e.test', password: 'deactme-password-1' });
      expect(login.status).toBe(201);
      const before = await agent.get('/api/v1/organisation');
      expect(before.status).toBe(200);

      const { AuthService } = await import('../auth/auth.service');
      const { AuditService: AuditSvc } = await import('../audit/audit.service');
      const { SessionService: SessSvc } = await import('../sessions/session.service');
      const authService = new AuthService(new SessSvc(), new AuditSvc());
      const user = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('user_accounts')
            .selectAll()
            .where('email', '=', 'deactme@e2e.test')
            .executeTakeFirstOrThrow(),
        pool,
      );
      await withOrgContext(
        organisationId,
        (db) => authService.deactivateAccount(db, organisationId, user.id, user.id),
        pool,
      );

      const after = await agent.get('/api/v1/organisation');
      expect(after.status).toBe(401);
    });

    it('password reset (self-service) revokes all existing sessions - logout-everywhere', async () => {
      await withOrgContext(
        organisationId,
        async (db) => {
          const { hashPassword } = await import('../security/passwords');
          await db
            .insertInto('user_accounts')
            .values({
              organisation_id: organisationId,
              email: 'resetme@e2e.test',
              password_hash: await hashPassword('resetme-original-1'),
              is_active: true,
            })
            .execute();
        },
        pool,
      );

      const agent = request.agent(server());
      const login = await agent
        .post('/api/v1/auth/login')
        .send({ email: 'resetme@e2e.test', password: 'resetme-original-1' });
      expect(login.status).toBe(201);

      const user = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('user_accounts')
            .selectAll()
            .where('email', '=', 'resetme@e2e.test')
            .executeTakeFirstOrThrow(),
        pool,
      );
      const resetService = new PasswordResetService(new SessionService());
      const resetToken = await withOrgContext(
        organisationId,
        (db) => resetService.requestReset(db, organisationId, user.id),
        pool,
      );
      await withOrgContext(
        organisationId,
        (db) =>
          resetService.completeReset(db, organisationId, resetToken, 'resetme-new-password-2'),
        pool,
      );

      // The session established before the reset must now be dead.
      const after = await agent.get('/api/v1/organisation');
      expect(after.status).toBe(401);
    });
  });

  describe('MFA session rotation', () => {
    it('MFA completion rotates the session id and issues a fresh CSRF token', async () => {
      const totpService = new TotpService();
      const enrolment = totpService.beginEnrolment('mfa-e2e@e2e.test');

      await withOrgContext(
        organisationId,
        async (db) => {
          const { hashPassword } = await import('../security/passwords');
          const user = await db
            .insertInto('user_accounts')
            .values({
              organisation_id: organisationId,
              email: 'mfa-e2e@e2e.test',
              password_hash: await hashPassword('mfa-e2e-password-1'),
              is_active: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const { authenticator } = await import('otplib');
          const code = authenticator.generate(enrolment.secret);
          await totpService.completeEnrolment(db, user.id, enrolment.secret, code, organisationId);
        },
        pool,
      );

      const agent = request.agent(server());
      const login = await agent
        .post('/api/v1/auth/login')
        .send({ email: 'mfa-e2e@e2e.test', password: 'mfa-e2e-password-1' });
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
      const mfaRes = await agent
        .post('/api/v1/auth/mfa/verify')
        .set('X-Hexyrn-CSRF', preMfaCsrf)
        .send({ code });
      expect(mfaRes.status).toBe(201);
      expect(mfaRes.body.verified).toBe(true);
      expect(mfaRes.body.csrfToken).not.toBe(preMfaCsrf);

      // The rotated session works for authenticated requests using the NEW csrf token.
      const afterRes = await agent.get('/api/v1/organisation');
      expect(afterRes.status).toBe(200);
    });
  });

  describe('MFA enrolment (P0 item 16, full end-to-end flow)', () => {
    it('generate secret -> proof of possession -> recovery codes -> secret never re-exposed -> audited', async () => {
      await withOrgContext(
        organisationId,
        async (db) => {
          const { hashPassword } = await import('../security/passwords');
          await db
            .insertInto('user_accounts')
            .values({
              organisation_id: organisationId,
              email: 'enrol-e2e@e2e.test',
              password_hash: await hashPassword('enrol-e2e-password-1'),
              is_active: true,
            })
            .execute();
        },
        pool,
      );

      const agent = request.agent(server());
      const login = await agent
        .post('/api/v1/auth/login')
        .send({ email: 'enrol-e2e@e2e.test', password: 'enrol-e2e-password-1' });
      expect(login.status).toBe(201);
      expect(login.body.requiresMfa).toBe(false); // not enrolled yet
      const csrfToken = login.body.csrfToken;

      // Step 1: begin - returns a secret, nothing persisted yet.
      const begin = await agent
        .post('/api/v1/auth/mfa/enroll/begin')
        .set('X-Hexyrn-CSRF', csrfToken);
      expect(begin.status).toBe(201);
      expect(begin.body.secret).toBeDefined();
      expect(begin.body.otpauthUrl).toContain('otpauth://totp/');

      const user = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('user_accounts')
            .selectAll()
            .where('email', '=', 'enrol-e2e@e2e.test')
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(user.mfa_enabled).toBe(false);
      expect(user.totp_secret_encrypted).toBeNull();

      // Wrong code must NOT enable MFA.
      const badConfirm = await agent
        .post('/api/v1/auth/mfa/enroll/confirm')
        .set('X-Hexyrn-CSRF', csrfToken)
        .send({ secret: begin.body.secret, code: '000000' });
      expect(badConfirm.status).toBe(400);

      // Step 2: confirm with a real proof-of-possession code.
      const { authenticator } = await import('otplib');
      const code = authenticator.generate(begin.body.secret);
      const confirm = await agent
        .post('/api/v1/auth/mfa/enroll/confirm')
        .set('X-Hexyrn-CSRF', csrfToken)
        .send({ secret: begin.body.secret, code });
      expect(confirm.status).toBe(201);
      expect(confirm.body.enabled).toBe(true);
      expect(confirm.body.recoveryCodes).toHaveLength(10);
      confirm.body.recoveryCodes.forEach((c: string) => expect(c).toMatch(/^\d{10}$/));

      // Now genuinely enabled, encrypted at rest, and the secret is not stored in plaintext anywhere.
      const after = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('user_accounts')
            .selectAll()
            .where('email', '=', 'enrol-e2e@e2e.test')
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(after.mfa_enabled).toBe(true);
      expect(after.totp_secret_encrypted).not.toBeNull();
      expect(after.totp_secret_encrypted).not.toContain(begin.body.secret);

      // Recovery codes are hashed at rest, never stored in plaintext.
      const recoveryRows = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('mfa_recovery_codes')
            .selectAll()
            .where('user_account_id', '=', user.id)
            .execute(),
        pool,
      );
      expect(recoveryRows).toHaveLength(10);
      for (const row of recoveryRows) {
        expect(confirm.body.recoveryCodes).not.toContain(row.code_hash);
      }

      // Audited.
      const events = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('audit_events')
            .selectAll()
            .where('event_type', '=', 'auth.mfa.enrolled')
            .where('actor_user_account_id', '=', user.id)
            .execute(),
        pool,
      );
      expect(events.length).toBeGreaterThanOrEqual(1);

      // Subsequent login now requires MFA, and a recovery code works exactly once.
      const agent2 = request.agent(server());
      const login2 = await agent2
        .post('/api/v1/auth/login')
        .send({ email: 'enrol-e2e@e2e.test', password: 'enrol-e2e-password-1' });
      expect(login2.body.requiresMfa).toBe(true);

      const recoveryCode = confirm.body.recoveryCodes[0];
      const useRecovery = await agent2
        .post('/api/v1/auth/mfa/verify')
        .set('X-Hexyrn-CSRF', login2.body.csrfToken)
        .send({ code: recoveryCode });
      expect(useRecovery.status).toBe(201);

      // The same recovery code cannot be used twice.
      const agent3 = request.agent(server());
      const login3 = await agent3
        .post('/api/v1/auth/login')
        .send({ email: 'enrol-e2e@e2e.test', password: 'enrol-e2e-password-1' });
      const reuseRecovery = await agent3
        .post('/api/v1/auth/mfa/verify')
        .set('X-Hexyrn-CSRF', login3.body.csrfToken)
        .send({ code: recoveryCode });
      expect(reuseRecovery.status).toBe(400);
    });
  });

  describe('Administrator-assisted MFA reset (Architecture §6 / P3 item 33)', () => {
    it('an admin holding core.users.mfa_reset can reset another user\'s MFA - target re-enrolment required, sessions revoked, audited', async () => {
      // A fresh target user, enrolled in MFA end-to-end via the real HTTP flow.
      await withOrgContext(
        organisationId,
        async (db) => {
          const { hashPassword } = await import('../security/passwords');
          await db
            .insertInto('user_accounts')
            .values({
              organisation_id: organisationId,
              email: 'mfa-reset-target@e2e.test',
              password_hash: await hashPassword('mfa-reset-target-password-1'),
              is_active: true,
            })
            .execute();
        },
        pool,
      );

      const targetAgent = request.agent(server());
      const targetLogin = await targetAgent
        .post('/api/v1/auth/login')
        .send({ email: 'mfa-reset-target@e2e.test', password: 'mfa-reset-target-password-1' });
      const targetCsrf = targetLogin.body.csrfToken;

      const begin = await targetAgent
        .post('/api/v1/auth/mfa/enroll/begin')
        .set('X-Hexyrn-CSRF', targetCsrf);
      const { authenticator } = await import('otplib');
      const code = authenticator.generate(begin.body.secret);
      await targetAgent
        .post('/api/v1/auth/mfa/enroll/confirm')
        .set('X-Hexyrn-CSRF', targetCsrf)
        .send({ secret: begin.body.secret, code });

      const target = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('user_accounts')
            .selectAll()
            .where('email', '=', 'mfa-reset-target@e2e.test')
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(target.mfa_enabled).toBe(true);

      // The target's session (established before the reset) should be
      // revoked as a side effect - prove it still works right now, before
      // the reset, as a baseline.
      const preResetCheck = await targetAgent.get('/api/v1/organisation');
      expect(preResetCheck.status).toBe(200);

      // The owner (holds every CORE_PERMISSIONS entry, including the new
      // USERS_MFA_RESET, via bootstrap's ALL_CORE_PERMISSIONS grant)
      // performs the reset.
      const adminAgent = request.agent(server());
      const adminLogin = await adminAgent
        .post('/api/v1/auth/login')
        .send({ email: ownerEmail, password: ownerPassword });
      const adminCsrf = adminLogin.body.csrfToken;

      const reset = await adminAgent
        .post(`/api/v1/auth/users/${target.id}/mfa/reset`)
        .set('X-Hexyrn-CSRF', adminCsrf);
      expect(reset.status).toBe(201);
      expect(reset.body).toEqual({ reset: true });

      // Same admin, same still-valid session, attempting to reset their OWN
      // MFA through this endpoint - rejected by the self-target guard, not
      // by the permission check (the admin genuinely holds
      // USERS_MFA_RESET), proving the guard is a distinct, deliberate check.
      const ownerRow = await withOrgContext(
        organisationId,
        (db) => db.selectFrom('user_accounts').select(['id']).where('email', '=', ownerEmail).executeTakeFirstOrThrow(),
        pool,
      );
      const adminOwnReset = await adminAgent
        .post(`/api/v1/auth/users/${ownerRow.id}/mfa/reset`)
        .set('X-Hexyrn-CSRF', adminCsrf);
      expect(adminOwnReset.status).toBe(400);

      const afterReset = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('user_accounts')
            .selectAll()
            .where('id', '=', target.id)
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(afterReset.mfa_enabled).toBe(false);
      expect(afterReset.totp_secret_encrypted).toBeNull();

      const remainingCodes = await withOrgContext(
        organisationId,
        (db) => db.selectFrom('mfa_recovery_codes').selectAll().where('user_account_id', '=', target.id).execute(),
        pool,
      );
      expect(remainingCodes).toHaveLength(0);

      // The target's pre-existing session is now revoked.
      const postResetCheck = await targetAgent.get('/api/v1/organisation');
      expect(postResetCheck.status).toBe(401);

      // The target logs back in - no longer prompted for MFA (it was reset,
      // not preserved) - and must re-enrol before MFA is required again.
      const targetAgent2 = request.agent(server());
      const targetLogin2 = await targetAgent2
        .post('/api/v1/auth/login')
        .send({ email: 'mfa-reset-target@e2e.test', password: 'mfa-reset-target-password-1' });
      expect(targetLogin2.body.requiresMfa).toBe(false);

      const events = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('audit_events')
            .selectAll()
            .where('event_type', '=', 'auth.mfa.admin_reset')
            .where('entity_ref', '=', target.id)
            .execute(),
        pool,
      );
      expect(events).toHaveLength(1);
      expect(events[0].actor_user_account_id).not.toBeNull();
    });

    it('a user without core.users.mfa_reset is rejected (403), not silently ignored', async () => {
      const targetAgent2 = request.agent(server());
      const login2 = await targetAgent2
        .post('/api/v1/auth/login')
        .send({ email: 'mfa-reset-target@e2e.test', password: 'mfa-reset-target-password-1' });
      const res = await targetAgent2
        .post('/api/v1/auth/users/some-other-id/mfa/reset')
        .set('X-Hexyrn-CSRF', login2.body.csrfToken)
        .send();
      expect(res.status).toBe(403);
    });
  });
});
