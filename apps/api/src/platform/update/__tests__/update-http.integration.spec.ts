import { TEST_RELEASE_PRIVATE_KEY_1_PEM } from '../../../vendor-tools/release-signing/test-private-keys';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { Pool } from 'pg';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AppModule } from '../../../app.module';
import { setUpTestDatabase } from '../../../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../../../db/pool';
import { InstallationService } from '../../../bootstrap/installation.service';
import { BootstrapService } from '../../../bootstrap/bootstrap.service';
import { signReleaseManifest, buildReleaseManifest } from '../../release-signing/release-signer';
import { TEST_RELEASE_KEY_ID_1 } from '../../release-signing/release-keys';
import { CORE_VERSION } from '../../core-version';

/**
 * Real HTTP-layer tests for the update admin endpoints (P3 items 14/15,
 * HTTP surface). POST /update/apply is tested with requireBackup: false
 * specifically so it exercises its REAL migration-running
 * (runPendingMigrations, a pure-Postgres function with no external
 * binary dependency) and REAL health-check path without needing the
 * pg_dump binary the auto-backup preflight would otherwise require (see
 * P3-ENVIRONMENT-VERIFICATION.md) - this is a genuine, non-mocked
 * end-to-end run of everything except the backup-binary boundary.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Update admin HTTP endpoints (P3 items 14/15)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let ownerEmail: string;
  let ownerPassword: string;
  let csrfToken: string;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.MIGRATE_DATABASE_URL = TEST_DATABASE_URL;
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    process.env.COOKIE_SECURE = 'false';

    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    setPool(pool);
    // setUpTestDatabase() replays every migration .sql file directly
    // (drop everything, reapply) rather than through the real CLI runner,
    // so it never populates schema_migrations - but the schema IS already
    // fully applied. Pre-populate schema_migrations with every real
    // migration filename so runPendingMigrations() (called for real by
    // POST /update/apply below) correctly sees "nothing pending" instead
    // of trying to re-run CREATE TABLE statements against tables that
    // already exist. This is itself a realistic, valid update scenario -
    // an update package whose migrationNotes says "no schema changes."
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const migrationFiles = (
      await fs.readdir(join(__dirname, '..', '..', '..', 'db', 'migrations'))
    ).filter((f) => f.endsWith('.sql'));
    for (const file of migrationFiles) {
      await pool.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file],
      );
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const installationService = app.get(InstallationService);
    const bootstrapService = app.get(BootstrapService);
    const bootstrap = await installationService.ensureInstallation();
    ownerEmail = 'update-http-owner@e2e.test';
    ownerPassword = 'a-very-strong-owner-password-1';
    await bootstrapService.completeBootstrap({
      token: bootstrap.plaintextBootstrapToken!,
      organisationName: 'Update HTTP Test Org',
      organisationDisplayName: 'Update HTTP Test Org',
      defaultCurrency: 'USD',
      timezone: 'UTC',
      locale: 'en-US',
      financialYearStartMonth: 1,
      ownerEmail,
      ownerPassword,
    });

    agent = request.agent(server());
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: ownerEmail, password: ownerPassword });
    csrfToken = login.body.csrfToken;
  }, 60000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  function server() {
    return app.getHttpAdapter().getInstance().server;
  }

  async function makePackage(version: string) {
    const dir = await fs.mkdtemp(join(tmpdir(), 'hexyrn-update-pkg-http-'));
    const path = join(dir, 'update.pkg');
    await fs.writeFile(path, 'FAKE UPDATE PACKAGE BYTES');
    const manifest = await buildReleaseManifest(path, {
      formatVersion: 1,
      productId: 'hexyrn-core',
      version,
      requiresCoreVersion: version,
      artifactType: 'offline-update-package',
      migrationNotes: null,
    });
    const signed = signReleaseManifest(
      manifest,
      TEST_RELEASE_KEY_ID_1,
      TEST_RELEASE_PRIVATE_KEY_1_PEM,
    );
    return { path, signed };
  }

  it('POST /update/check verifies a real signed package and reports readiness without applying anything', async () => {
    const { path, signed } = await makePackage(CORE_VERSION);
    const res = await agent
      .post('/api/v1/update/check')
      .set('X-Hexyrn-CSRF', csrfToken)
      .send({ packagePath: path, manifest: signed });

    expect(res.status).toBe(201);
    expect(res.body.packageAuthentic).toBe(true);
    expect(res.body.compatible).toBe(true);
    expect(res.body.readyToApply).toBe(true);
  });

  it('POST /update/check flags a tampered package as inauthentic', async () => {
    const { path, signed } = await makePackage(CORE_VERSION);
    await fs.writeFile(path, 'TAMPERED BYTES, DIFFERENT LENGTH ENTIRELY');
    const res = await agent
      .post('/api/v1/update/check')
      .set('X-Hexyrn-CSRF', csrfToken)
      .send({ packagePath: path, manifest: signed });

    expect(res.body.packageAuthentic).toBe(false);
    expect(res.body.readyToApply).toBe(false);
  });

  it('POST /update/apply refuses without confirmed: true', async () => {
    const { path, signed } = await makePackage(CORE_VERSION);
    const res = await agent
      .post('/api/v1/update/apply')
      .set('X-Hexyrn-CSRF', csrfToken)
      .send({ packagePath: path, manifest: signed });
    expect(res.status).toBe(400);
  });

  it('POST /update/apply runs the REAL sequence end to end (verify -> compatible -> disk -> backup-preflight(skipped) -> maintenance mode -> REAL migrations -> REAL health check -> exit maintenance mode) and succeeds', async () => {
    const { path, signed } = await makePackage(CORE_VERSION);
    const res = await agent
      .post('/api/v1/update/apply')
      .set('X-Hexyrn-CSRF', csrfToken)
      .send({ packagePath: path, manifest: signed, confirmed: true, requireBackup: false });

    expect(res.status).toBe(201);
    expect(res.body.succeeded).toBe(true);
    expect(res.body.maintenanceModeActive).toBe(false);
    const stepNames = res.body.steps.map((s: any) => s.step);
    expect(stepNames).toEqual([
      'verify_package',
      'check_compatibility',
      'check_disk_space',
      'backup_preflight',
      'enter_maintenance_mode',
      'run_migrations',
      'health_check',
      'exit_maintenance_mode',
    ]);
    expect(res.body.steps.every((s: any) => s.ok)).toBe(true);

    // Maintenance mode was genuinely set then cleared on the real
    // installations.config JSONB column, not a fake in-memory flag.
    const row = await pool.query<{ config: any }>('SELECT config FROM installations LIMIT 1');
    expect(row.rows[0].config.maintenanceMode).toBe(false);
  }, 30000);

  it('an unauthenticated caller cannot check or apply updates', async () => {
    const anon = request.agent(server());
    expect((await anon.post('/api/v1/update/check').send({})).status).toBe(401);
    expect((await anon.post('/api/v1/update/apply').send({})).status).toBe(401);
  });
});
