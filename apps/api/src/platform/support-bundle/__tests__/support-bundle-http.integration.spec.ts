import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../../app.module';
import { setUpTestDatabase } from '../../../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../../../db/pool';
import { InstallationService } from '../../../bootstrap/installation.service';
import { BootstrapService } from '../../../bootstrap/bootstrap.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Support bundle admin HTTP endpoints (P3 item 21/8)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
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
    ownerEmail = 'support-bundle-http-owner@e2e.test';
    ownerPassword = 'a-very-strong-owner-password-1';
    await bootstrapService.completeBootstrap({
      token: bootstrap.plaintextBootstrapToken!,
      organisationName: 'Support Bundle HTTP Test Org',
      organisationDisplayName: 'Support Bundle HTTP Test Org',
      defaultCurrency: 'USD',
      timezone: 'UTC',
      locale: 'en-US',
      financialYearStartMonth: 1,
      ownerEmail,
      ownerPassword,
    });

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

  it('GET /support-bundle/preview lists categories before generation', async () => {
    const res = await agent.get('/api/v1/support-bundle/preview');
    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBeGreaterThan(0);
    expect(res.body.categories.some((c: any) => c.key === 'versions')).toBe(true);
  });

  it('POST /support-bundle generates a real bundle for this organisation, contains no secret-shaped values', async () => {
    const res = await agent.post('/api/v1/support-bundle').set('X-Hexyrn-CSRF', csrfToken);
    expect(res.status).toBe(201);
    expect(res.body.formatVersion).toBe(1);
    expect(res.body.coreVersion).toBeDefined();

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(ownerPassword);
    expect(res.body).not.toHaveProperty('password');
  });

  it('an unauthenticated caller cannot preview or generate a support bundle', async () => {
    const anon = request.agent(server());
    expect((await anon.get('/api/v1/support-bundle/preview')).status).toBe(401);
    expect((await anon.post('/api/v1/support-bundle')).status).toBe(401);
  });
});
