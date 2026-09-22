import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../../app.module';
import { setUpTestDatabase } from '../../../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../../../db/pool';
import { withOrgContext } from '../../../db/org-context';
import { InstallationService } from '../../../bootstrap/installation.service';
import { BootstrapService } from '../../../bootstrap/bootstrap.service';
import { Kysely } from 'kysely';
import { Database } from '../../../db/types';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Health/Diagnostics - real HTTP layer (P3 item 19/20)', () => {
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
    // health-diagnostics.service.ts queries schema_migrations, which (like
    // support-bundle.service.spec.ts found) setUpTestDatabase()'s
    // replay-every-migration-file path never creates, unlike the real
    // apps/api/src/db/migrate.ts CLI runner used in production.
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`INSERT INTO schema_migrations (filename) VALUES ('0001_test.sql') ON CONFLICT DO NOTHING`);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const installationService = app.get(InstallationService);
    const bootstrapService = app.get(BootstrapService);
    const bootstrap = await installationService.ensureInstallation();
    ownerEmail = 'health-owner@e2e.test';
    ownerPassword = 'a-very-strong-owner-password-1';
    const result = await bootstrapService.completeBootstrap({
      token: bootstrap.plaintextBootstrapToken!,
      organisationName: 'Health Test Org',
      organisationDisplayName: 'Health Test Org',
      defaultCurrency: 'USD',
      timezone: 'UTC',
      locale: 'en-US',
      financialYearStartMonth: 1,
      ownerEmail,
      ownerPassword,
    });
    organisationId = result.organisationId;

    agent = request.agent(server());
    const login = await agent.post('/api/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
    csrfToken = login.body.csrfToken;
    void csrfToken;
  }, 60000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function server() {
    return app.getHttpAdapter().getInstance().server;
  }

  it('GET /system/health reports a healthy system (SMTP not yet configured is a warning, not an error) with no secrets exposed', async () => {
    const res = await agent.get('/api/v1/system/health');
    expect(res.status).toBe(200);
    expect(res.body.database.status).toBe('ok');
    expect(res.body.migrations.appliedCount).toBeGreaterThan(0);
    expect(res.body.backgroundJobs.failedCount).toBe(0);
    expect(res.body.backgroundJobs.status).toBe('ok');
    // SMTP is not configured yet at this point in the suite - correctly a
    // 'warning' (a documented, safe fallback per item 24), not an 'error',
    // and it is what makes overallStatus 'warning' here rather than 'ok'.
    expect(res.body.smtp.status).toBe('warning');
    expect(res.body.overallStatus).toBe('warning');

    const serialized = JSON.stringify(res.body);
    // "password" legitimately appears in the SMTP warning's own explanatory
    // text ("password-reset links must be shared manually") - assert no
    // password/secret VALUE-shaped field exists, not that the word never
    // appears anywhere in human-readable prose.
    expect(res.body).not.toHaveProperty('password');
    expect(res.body.smtp).not.toHaveProperty('password');
    expect(serialized.toLowerCase()).not.toContain('secretkey');
  });

  it('GET /system/diagnostics reports real environment info, no secrets', async () => {
    const res = await agent.get('/api/v1/system/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.coreVersion).toBeDefined();
    expect(res.body.nodeVersion).toBe(process.version);
    expect(res.body.platform).toContain(process.platform);
    expect(res.body.databaseVersion).toMatch(/postgres/i);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('password');
  });

  it('a failed background job is reflected as a warning with an actionable detail, and flips overallStatus', async () => {
    await withOrgContext(
      organisationId,
      (db: Kysely<Database>) =>
        db
          .insertInto('scheduled_jobs')
          .values({ organisation_id: organisationId, app_id: 'com.hexyrn.requisite', job_type: 'test-job', status: 'failed', last_error: 'boom' })
          .execute(),
      pool,
    );

    const res = await agent.get('/api/v1/system/health');
    expect(res.body.backgroundJobs.status).toBe('warning');
    expect(res.body.backgroundJobs.failedCount).toBeGreaterThanOrEqual(1);
    expect(res.body.backgroundJobs.detail).toMatch(/failed background job/i);
    expect(res.body.overallStatus).toBe('warning'); // rolled up correctly, not masked by other 'ok' checks
  });

  it('reports smtp as configured after a real SMTP config is set, without exposing the password', async () => {
    await agent
      .post('/api/v1/smtp')
      .set('X-Hexyrn-CSRF', csrfToken)
      .send({ host: 'smtp.example.com', port: 587, secure: false, username: 'u', password: 'a-real-canary-password-value', fromAddress: 'hexyrn@example.com' });

    const res = await agent.get('/api/v1/system/health');
    expect(res.body.smtp.status).toBe('ok');
    expect(res.body.smtp.detail).toContain('smtp.example.com');
    expect(JSON.stringify(res.body)).not.toContain('a-real-canary-password-value');
  });

  it('an unauthenticated caller cannot reach health or diagnostics', async () => {
    const anon = request.agent(server());
    expect((await anon.get('/api/v1/system/health')).status).toBe(401);
    expect((await anon.get('/api/v1/system/diagnostics')).status).toBe(401);
  });

  it('the public /api/v1/health liveness probe remains separate, minimal, and unauthenticated', async () => {
    const anon = request.agent(server());
    const res = await anon.get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
