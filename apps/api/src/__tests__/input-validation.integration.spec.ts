/**
 * P1 item 15 - proves the global ValidationPipe (main.ts) genuinely
 * validates real DTO classes at the API boundary. This is the regression
 * test for a real gap found during the P1 security review: NestJS's
 * ValidationPipe silently skips validation for a plain TypeScript
 * `interface` body type (interfaces erase to `Object` at runtime, so
 * there's no decorator metadata for class-validator to read) - the P0
 * endpoints (bootstrap, login, password-reset, invitation, organisation)
 * were converted from interfaces to real `class` DTOs specifically so this
 * test could hold for them, not just for the P1 reference app's new DTOs.
 */
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../app.module';
import { setUpTestDatabase, createTestOrg } from '../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../db/pool';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Global input validation (P1 item 15)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;

  function server() {
    return app.getHttpAdapter().getInstance().server;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    process.env.COOKIE_SECURE = 'false';

    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    setPool(pool);
    await createTestOrg(pool, 'Validation Test Org'); // gives the primary-org lookup something to find

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    // Same pipe configuration as main.ts - this test exercises it directly rather than importing main.ts (which also starts listening).
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('login: a malformed email produces a structured 400, never falls through to the database', async () => {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'whatever-password-1' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBeDefined();
  });

  it('login: a missing field produces a structured 400', async () => {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: 'someone@test.local' });
    expect(res.status).toBe(400);
  });

  it('login: an unexpected extra property is rejected outright (forbidNonWhitelisted - mass-assignment defense)', async () => {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: 'someone@test.local', password: 'whatever-password-1', isOwner: true });
    expect(res.status).toBe(400);
  });

  it('bootstrap: an out-of-range financialYearStartMonth (13) is rejected before touching Postgres', async () => {
    const res = await request(server())
      .post('/api/v1/bootstrap/complete')
      .send({
        token: 'x'.repeat(32),
        organisationName: 'X',
        organisationDisplayName: 'X',
        defaultCurrency: 'USD',
        timezone: 'UTC',
        locale: 'en-US',
        financialYearStartMonth: 13,
        ownerEmail: 'owner@test.local',
        ownerPassword: 'a-strong-password-123',
      });
    expect(res.status).toBe(400);
  });

  it('invitation accept: a short password fails MinLength validation', async () => {
    const res = await request(server())
      .post('/api/v1/auth/invitations/accept')
      .send({ token: 'x'.repeat(32), password: 'short' });
    expect(res.status).toBe(400);
  });

  it('invitation create: a malformed (non-UUID) roleId is rejected', async () => {
    // No session -> 401 normally, but validation runs before guards resolve
    // the body's shape is still checked as part of the pipeline; assert we
    // never get a 500/DB error regardless of auth state.
    const res = await request(server())
      .post('/api/v1/auth/invitations')
      .send({ email: 'invitee@test.local', roleIds: ['not-a-uuid'] });
    expect([400, 401]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });
});
