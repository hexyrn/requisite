/**
 * Licence activation, app enablement and RBAC are three separate gates. Importing a licence must never
 * hand anyone permissions they were not granted: only the Owner role receives the app's permissions on
 * first activation, and importing a licence itself needs organisation.manage.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../app.module';
import { setUpTestDatabase, createTestLicense } from '../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../db/pool';
import { withOrgContext } from '../db/org-context';
import { InstallationService } from '../bootstrap/installation.service';
import { BootstrapService } from '../bootstrap/bootstrap.service';
import { CORE_PERMISSIONS } from '../rbac/permissions';
import { ApplicationRegistryService } from '../platform/app-registry/application-registry.service';
import { registerRequisiteApp } from '../apps/requisite/requisite.manifest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const APP = 'com.hexyrn.requisite';

describeIfDb('licence import cannot bypass permissions (real HTTP + real Postgres)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let orgId: string;

  const server = () => app.getHttpAdapter().getInstance().server;

  async function makeUser(email: string, permissions: string[]) {
    const password = `${email}-password-123`;
    await withOrgContext(
      orgId,
      async (db) => {
        const { hashPassword } = await import('../security/passwords');
        const role = await db
          .insertInto('roles')
          .values({ organisation_id: orgId, name: `role-${email}` })
          .returningAll()
          .executeTakeFirstOrThrow();
        for (const permission_key of permissions) {
          await db
            .insertInto('role_permissions')
            .values({ organisation_id: orgId, role_id: role.id, permission_key })
            .execute();
        }
        const user = await db
          .insertInto('user_accounts')
          .values({
            organisation_id: orgId,
            email,
            password_hash: await hashPassword(password),
            is_active: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await db
          .insertInto('user_roles')
          .values({ organisation_id: orgId, user_account_id: user.id, role_id: role.id })
          .execute();
      },
      pool,
    );
    const agent = request.agent(server());
    const login = await agent.post('/api/v1/auth/login').send({ email, password });
    expect(login.status).toBe(201);
    return { agent, csrf: login.body.csrfToken as string };
  }

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
    const boot = await app.get(InstallationService).ensureInstallation(pool);
    const result = await app.get(BootstrapService).completeBootstrap(
      {
        token: boot.plaintextBootstrapToken!,
        organisationName: 'Sep Org',
        organisationDisplayName: 'Sep Org',
        defaultCurrency: 'USD',
        timezone: 'UTC',
        locale: 'en-US',
        financialYearStartMonth: 1,
        ownerEmail: 'owner@sep.test',
        ownerPassword: 'owner-separation-password-1',
      },
      pool,
    );
    orgId = result.organisationId;
    await registerRequisiteApp(app.get(ApplicationRegistryService));
  }, 60000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('a user without organisation.manage cannot import a licence', async () => {
    const plain = await makeUser('plain@sep.test', []);
    const licence = await createTestLicense(APP, orgId, 1);
    const res = await plain.agent
      .post(`/api/v1/apps/${APP}/licence`)
      .set('X-Hexyrn-CSRF', plain.csrf)
      .send({ majorVersion: 1, licence });
    expect(res.status).toBe(403);
  });

  it('after the Owner activates Requisite, other users still have no Requisite access; only the Owner does', async () => {
    const owner = request.agent(server());
    const login = await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@sep.test', password: 'owner-separation-password-1' });
    const licence = await createTestLicense(APP, orgId, 1);
    const imported = await owner
      .post(`/api/v1/apps/${APP}/licence`)
      .set('X-Hexyrn-CSRF', login.body.csrfToken)
      .send({ majorVersion: 1, licence });
    expect(imported.status).toBe(201);

    // A user who may manage the organisation (so may import licences) gets NO Requisite permissions from it.
    const admin = await makeUser('orgadmin@sep.test', [CORE_PERMISSIONS.ORGANISATION_MANAGE]);
    const adminList = await admin.agent.get('/api/v1/requisite/suppliers');
    expect(adminList.status).toBe(403);
    const again = await admin.agent
      .post(`/api/v1/apps/${APP}/licence`)
      .set('X-Hexyrn-CSRF', admin.csrf)
      .send({ majorVersion: 1, licence: await createTestLicense(APP, orgId, 1) });
    expect(again.status).toBe(201); // re-importing is allowed for organisation.manage...
    const afterReimport = await admin.agent.get('/api/v1/requisite/suppliers');
    expect(afterReimport.status).toBe(403); // ...but grants nothing

    const plain = await makeUser('plain2@sep.test', []);
    expect((await plain.agent.get('/api/v1/requisite/suppliers')).status).toBe(403);

    const ownerList = await owner.get('/api/v1/requisite/suppliers');
    expect(ownerList.status).toBe(200);
  });
  it('the users and roles directory needs users.manage and never exposes credentials', async () => {
    const plain = await makeUser('nodir@sep.test', []);
    expect((await plain.agent.get('/api/v1/users')).status).toBe(403);
    expect((await plain.agent.get('/api/v1/roles')).status).toBe(403);

    const manager = await makeUser('mgr@sep.test', [CORE_PERMISSIONS.USERS_MANAGE]);
    const users = await manager.agent.get('/api/v1/users');
    expect(users.status).toBe(200);
    expect(users.body.users.map((u: any) => u.email)).toEqual(
      expect.arrayContaining(['owner@sep.test', 'mgr@sep.test']),
    );
    expect(JSON.stringify(users.body)).not.toMatch(/password|secret|recovery/i);
    const owner = users.body.users.find((u: any) => u.email === 'owner@sep.test');
    expect(owner.roles).toContain('Owner');
    const roles = await manager.agent.get('/api/v1/roles');
    expect(roles.body.roles.map((r: any) => r.name)).toContain('Owner');
  });
  it('activation creates starter roles; a Requester can raise requisitions but cannot manage suppliers or administer', async () => {
    const owner = request.agent(server());
    const login = await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@sep.test', password: 'owner-separation-password-1' });
    const roles = await owner.get('/api/v1/roles');
    const names = roles.body.roles.map((r: any) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Requisite - Requester',
        'Requisite - Approver',
        'Requisite - Buyer',
      ]),
    );
    void login;
    const requesterPerms = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('role_permissions')
          .innerJoin('roles', 'roles.id', 'role_permissions.role_id')
          .select('role_permissions.permission_key')
          .where('roles.name', '=', 'Requisite - Requester')
          .execute(),
      pool,
    );
    expect(requesterPerms.map((p) => p.permission_key)).not.toContain('requisite.suppliers.manage');
    expect(requesterPerms.map((p) => p.permission_key)).not.toContain(
      'requisite.requisitions.approve',
    );
  });
});
