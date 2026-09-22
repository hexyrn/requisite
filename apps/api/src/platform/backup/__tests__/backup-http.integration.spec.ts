import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { Pool } from 'pg';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AppModule } from '../../../app.module';
import { setUpTestDatabase, createTestLicense } from '../../../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../../../db/pool';
import { InstallationService } from '../../../bootstrap/installation.service';
import { BootstrapService } from '../../../bootstrap/bootstrap.service';
import { createBackup } from '../backup.service';

/**
 * Real HTTP-layer tests for the backup admin endpoints (P3 items 9-13,
 * HTTP surface). Everything NOT requiring the real pg_dump/pg_restore
 * binaries (unavailable in this sandbox - see backup.service.ts's own doc
 * comment and P3-ENVIRONMENT-VERIFICATION.md) is tested for real here:
 * permission gating, listing, integrity reporting, id-path-traversal
 * rejection, and the destructive-confirmation guard. `POST /backup` and
 * `POST /backup/:id/restore`'s actual pg_dump/pg_restore EXECUTION is
 * explicitly NOT exercised by an HTTP round trip in this file - it would
 * require the real binaries this sandbox does not have - but the
 * pre-execution validation (confirmation requirement, id safety) IS.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
void createTestLicense; // available if a future test needs it

describeIfDb('Backup admin HTTP endpoints (P3 items 9-13)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let ownerEmail: string;
  let ownerPassword: string;
  let csrfToken: string;
  let agent: ReturnType<typeof request.agent>;
  let backupsDir: string;

  beforeAll(async () => {
    backupsDir = await fs.mkdtemp(join(tmpdir(), 'hexyrn-backup-http-'));
    process.env.HEXYRN_BACKUP_DIR = backupsDir;
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
    ownerEmail = 'backup-http-owner@e2e.test';
    ownerPassword = 'a-very-strong-owner-password-1';
    await bootstrapService.completeBootstrap({
      token: bootstrap.plaintextBootstrapToken!,
      organisationName: 'Backup HTTP Test Org',
      organisationDisplayName: 'Backup HTTP Test Org',
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

  it('GET /backup returns an empty list before any backup exists', async () => {
    const res = await agent.get('/api/v1/backup');
    expect(res.status).toBe(200);
    expect(res.body.backups).toEqual([]);
  });

  it('lists a real, manually-created backup with its integrity status (using the fake-dump path createBackup already supports, matching backup.service.spec.ts\'s own pattern)', async () => {
    const storageDir = await fs.mkdtemp(join(tmpdir(), 'hexyrn-storage-http-'));
    await createBackup({
      destinationDir: join(backupsDir, '2026-01-01T00-00-00'),
      storageRootDir: storageDir,
      pool,
      runPgDump: async (outputPath) => {
        await fs.writeFile(outputPath, 'FAKE DUMP FOR HTTP LISTING TEST');
      },
    });

    const listRes = await agent.get('/api/v1/backup');
    expect(listRes.status).toBe(200);
    expect(listRes.body.backups.some((b: any) => b.backupId === '2026-01-01T00-00-00' && b.valid === true)).toBe(true);

    const getRes = await agent.get('/api/v1/backup/2026-01-01T00-00-00');
    expect(getRes.status).toBe(200);
    expect(getRes.body.valid).toBe(true);
    expect(getRes.body.manifest.formatVersion).toBe(1);
  });

  it('GET /backup/:id 404s for a backup that does not exist', async () => {
    const res = await agent.get('/api/v1/backup/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('rejects a backup id that looks like a path-traversal attempt, before ever touching the filesystem', async () => {
    const res = await agent.get('/api/v1/backup/..%2F..%2Fetc%2Fpasswd');
    // Either 400 (rejected by assertSafeBackupId) or 404 (Nest routing
    // normalises the path first) is an acceptable, SAFE outcome here -
    // what must NOT happen is a 200 with unrelated filesystem content.
    expect([400, 404]).toContain(res.status);
  });

  it('POST /backup/:id/restore refuses without confirmed: true - no destructive action attempted', async () => {
    const res = await agent
      .post('/api/v1/backup/2026-01-01T00-00-00/restore')
      .set('X-Hexyrn-CSRF', csrfToken)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/destructive/i);
  });

  it('an unauthenticated caller cannot list, read, or restore backups', async () => {
    const anon = request.agent(server());
    expect((await anon.get('/api/v1/backup')).status).toBe(401);
    expect((await anon.get('/api/v1/backup/2026-01-01T00-00-00')).status).toBe(401);
    expect((await anon.post('/api/v1/backup/2026-01-01T00-00-00/restore').send({ confirmed: true })).status).toBe(401);
  });
});
