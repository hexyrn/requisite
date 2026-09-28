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
import { ApplicationRegistryService } from '../application-registry.service';
import { REQUISITE_APP_MANIFEST } from '../../../apps/requisite/requisite.manifest';

/**
 * The REAL activation path of a fresh installation, with nothing pre-seeded
 * (every other test and the E2E seed script enable the app and grant its
 * permissions directly, which is exactly why this gap went unnoticed):
 * first-run setup -> import a signed licence -> the app is usable.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const APP_ID = REQUISITE_APP_MANIFEST.appId;

describeIfDb('Licence import activates a freshly installed app', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let organisationId: string;
  let csrf: string;
  let agent: ReturnType<typeof request.agent>;
  let registry: ApplicationRegistryService;
  const server = () => app.getHttpAdapter().getInstance().server;

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

    const bootstrap = await app.get(InstallationService).ensureInstallation();
    const result = await app.get(BootstrapService).completeBootstrap({
      token: bootstrap.plaintextBootstrapToken!,
      organisationName: 'Activation Org',
      organisationDisplayName: 'Activation Org',
      defaultCurrency: 'GBP',
      timezone: 'UTC',
      locale: 'en-GB',
      financialYearStartMonth: 1,
      ownerEmail: 'activation-owner@e2e.test',
      ownerPassword: 'a-very-strong-owner-password-1',
    });
    organisationId = result.organisationId;

    // What the real server does at boot for every compiled-in app.
    registry = app.get(ApplicationRegistryService);
    await registry.registerApp(REQUISITE_APP_MANIFEST, pool);

    agent = request.agent(server());
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'activation-owner@e2e.test', password: 'a-very-strong-owner-password-1' });
    csrf = login.body.csrfToken;
  }, 60000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const launcherEntry = async () => {
    const res = await agent.get('/api/v1/apps/launcher');
    return (res.body.apps as Array<{ appId: string; status: string; launchPath: string }>).find(
      (a) => a.appId === APP_ID,
    );
  };
  const importLicence = (licence: unknown, majorVersion = 1) =>
    agent
      .post(`/api/v1/apps/${APP_ID}/licence`)
      .set('X-Hexyrn-CSRF', csrf)
      .send({ majorVersion, licence });

  it('before any licence: the app is not usable, and not even reachable', async () => {
    expect((await launcherEntry())?.status).toBe('disabled');
    expect((await agent.get('/api/v1/requisite/requisitions')).status).toBe(404);
  });

  it('a forged licence is rejected and activates nothing', async () => {
    const good = await createTestLicense(APP_ID, organisationId, 1, null);
    const res = await importLicence({ ...good, majorVersion: 999 }, 999);
    expect(res.status).toBe(400);
    expect((await launcherEntry())?.status).toBe('disabled');
    expect((await agent.get('/api/v1/requisite/requisitions')).status).toBe(404);
  });

  it('a licence issued for a DIFFERENT organisation is rejected', async () => {
    const other = await createTestLicense(APP_ID, '00000000-0000-4000-8000-000000000000', 1, null);
    expect((await importLicence(other)).status).toBe(400);
    expect((await launcherEntry())?.status).toBe('disabled');
  });

  it('a valid licence activates the app: enabled, Owner holds its permissions, usable at once, audited', async () => {
    const licence = await createTestLicense(APP_ID, organisationId, 1, null);
    const res = await importLicence(licence);
    expect(res.status).toBe(201);
    expect(res.body.activated).toBe(true);
    expect(res.body.active).toBe(true);

    expect(await launcherEntry()).toMatchObject({ status: 'active', launchPath: '/requisite' });
    expect((await agent.get('/api/v1/requisite/requisitions')).status).toBe(200);

    const audit = await withOrgContext(
      organisationId,
      (db) =>
        db
          .selectFrom('audit_events')
          .select('event_type')
          .where('event_type', '=', 'app.activated')
          .where('entity_ref', '=', APP_ID)
          .execute(),
      pool,
    );
    expect(audit).toHaveLength(1);
  });

  it('a licence RENEWAL does not re-enable an app an administrator deliberately disabled', async () => {
    await withOrgContext(
      organisationId,
      (db) => registry.disableApp(db, organisationId, APP_ID),
      pool,
    );
    expect((await agent.get('/api/v1/requisite/requisitions')).status).toBe(404);

    const renewal = await createTestLicense(APP_ID, organisationId, 1, null);
    const res = await importLicence(renewal);
    expect(res.status).toBe(201);
    expect(res.body.activated).toBe(false);
    expect((await launcherEntry())?.status).toBe('disabled');
    expect((await agent.get('/api/v1/requisite/requisitions')).status).toBe(404);
  });
});
