import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../../app.module';
import { setUpTestDatabase, createTestLicense } from '../../../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../../../db/pool';
import { withOrgContext } from '../../../db/org-context';
import { InstallationService } from '../../../bootstrap/installation.service';
import { BootstrapService } from '../../../bootstrap/bootstrap.service';
import { Database } from '../../../db/types';
import { Kysely } from 'kysely';
import { ApplicationRegistryService } from '../application-registry.service';

/**
 * P3 item 10/25: real HTTP-layer proof of the licence administration UX -
 * import via HTTP, and critically the explicit test the spec calls out by
 * name: "support expired + perpetual licence valid = application continues
 * functioning" (Architecture §9 - support status must never become a
 * remote kill switch).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const APP_ID = 'com.hexyrn.requisite';

describeIfDb('Licence administration - real HTTP layer (P3 item 10/25)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let organisationId: string;
  let ownerEmail: string;
  let ownerPassword: string;
  let csrfToken: string;
  let agent: ReturnType<typeof request.agent>;

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
    const bootstrap = await installationService.ensureInstallation();
    ownerEmail = 'licence-admin-owner@e2e.test';
    ownerPassword = 'a-very-strong-owner-password-1';
    const result = await bootstrapService.completeBootstrap({
      token: bootstrap.plaintextBootstrapToken!,
      organisationName: 'Licence Admin Test Org',
      organisationDisplayName: 'Licence Admin Test Org',
      defaultCurrency: 'USD',
      timezone: 'UTC',
      locale: 'en-US',
      financialYearStartMonth: 1,
      ownerEmail,
      ownerPassword,
    });
    organisationId = result.organisationId;

    // Register the Requisite app's manifest at the installation level (no
    // HTTP route for this in v1 - boot-time action, Architecture §3), so
    // GET .../licence has something real to report against.
    const registry = app.get(ApplicationRegistryService);
    await withOrgContext(
      organisationId,
      (db: Kysely<Database>) =>
        (db as any)
          .insertInto('installed_applications')
          .values({
            app_id: APP_ID,
            display_name: 'Hexyrn Requisite',
            version: '1.0.0',
            major_version: 1,
            requires_core_version: '>=0.1.0',
            manifest: {},
          })
          .onConflict((oc: any) => oc.column('app_id').doNothing())
          .execute(),
      pool,
    );
    await withOrgContext(
      organisationId,
      (db: Kysely<Database>) =>
        (db as any)
          .insertInto('app_enablements')
          .values({ organisation_id: organisationId, app_id: APP_ID, enabled: true, enabled_at: new Date() })
          .onConflict((oc: any) => oc.columns(['organisation_id', 'app_id']).doUpdateSet({ enabled: true }))
          .execute(),
      pool,
    );
    void registry;

    agent = request.agent(server());
    const login = await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
    csrfToken = login.body.csrfToken;
  }, 60000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function server() {
    return app.getHttpAdapter().getInstance().server;
  }

  it('GET .../licence reports licenceValid: false before any licence is imported', async () => {
    const res = await agent.get(`/api/v1/apps/${APP_ID}/licence`);
    expect(res.status).toBe(200);
    expect(res.body.licenceValid).toBe(false);
    expect(res.body.licenceId).toBeNull();
    expect(res.body.installedVersion).toBe('1.0.0');
  });

  it('POST .../licence imports a real signed licence and the state is immediately reflected', async () => {
    const licence = await createTestLicense(APP_ID, organisationId, 1, null); // perpetual - no support expiry
    const res = await agent
      .post(`/api/v1/apps/${APP_ID}/licence`)
      .set('X-Hexyrn-CSRF', csrfToken)
      .send({ majorVersion: 1, licence });

    expect(res.status).toBe(201);
    expect(res.body.licenceValid).toBe(true);
    expect(res.body.licenceId).toBe(licence.licenseId);
    expect(res.body.licensedMajorVersion).toBe(1);
    expect(res.body.organisationId).toBe(organisationId);
    expect(res.body.supportExpiresAt).toBeNull();
    expect(res.body.supportExpired).toBeNull(); // perpetual - no expiry date to compare against, not "false"
  });

  it('rejects a tampered/forged licence payload via HTTP, never records it', async () => {
    const licence = await createTestLicense(APP_ID, organisationId, 1, null);
    const tampered = { ...licence, majorVersion: 999 }; // signature no longer matches this modified payload
    const res = await agent
      .post(`/api/v1/apps/${APP_ID}/licence`)
      .set('X-Hexyrn-CSRF', csrfToken)
      .send({ majorVersion: 999, licence: tampered });
    expect(res.status).toBe(400);
  });

  it('THE EXPLICIT SPEC REQUIREMENT: support expired + perpetual licence valid = application continues functioning', async () => {
    const pastExpiry = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(); // one year ago
    const licence = await createTestLicense(APP_ID, organisationId, 1, pastExpiry);
    const importRes = await agent
      .post(`/api/v1/apps/${APP_ID}/licence`)
      .set('X-Hexyrn-CSRF', csrfToken)
      .send({ majorVersion: 1, licence });
    expect(importRes.status).toBe(201);

    // Both independently true/reported, per LicenceDetail's design -
    // support expiry is informational, NEVER a runtime kill switch
    // (Architecture §9).
    expect(importRes.body.licenceValid).toBe(true);
    expect(importRes.body.supportExpired).toBe(true);
    expect(importRes.body.active).toBe(true); // the app keeps running - support status never gates `active`

    // A fresh GET confirms this isn't just the POST response's framing -
    // the persisted, queried state genuinely reflects both facts.
    const getRes = await agent.get(`/api/v1/apps/${APP_ID}/licence`);
    expect(getRes.body.licenceValid).toBe(true);
    expect(getRes.body.supportExpired).toBe(true);
    expect(getRes.body.active).toBe(true);
  });

  it('an unauthenticated caller cannot read or import licence data', async () => {
    const anon = request.agent(server());
    const getRes = await anon.get(`/api/v1/apps/${APP_ID}/licence`);
    expect(getRes.status).toBe(401);
  });
});
