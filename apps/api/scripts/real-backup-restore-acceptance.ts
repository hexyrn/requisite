/**
 * REAL pg_dump/pg_restore acceptance test (P3 items 13/14). Not a Jest
 * test - a standalone script, because it deliberately runs against a
 * dedicated, isolated database (never the shared dev/test database other
 * suites use) and shells out to the actual PostgreSQL client binaries
 * discovered on this machine, exactly as a production deployment would.
 *
 * Usage: PG_DUMP_PATH=... PG_RESTORE_PATH=... npx ts-node scripts/real-backup-restore-acceptance.ts
 *
 * Records exact tool versions and prints a clear PASS/FAIL per step.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

const PG_DUMP_PATH = process.env.PG_DUMP_PATH ?? 'pg_dump';
const PG_RESTORE_PATH = process.env.PG_RESTORE_PATH ?? 'pg_restore';
const TEST_DB_HOST = process.env.HARNESS_PG_HOST ?? '127.0.0.1';
const TEST_DB_PORT = process.env.HARNESS_PG_PORT ?? '5432';
const TEST_DB_USER = process.env.HARNESS_PG_USER ?? 'hexyrn';
const TEST_DB_PASSWORD = process.env.HARNESS_PG_PASSWORD ?? 'hexyrn_test_password';
const TEST_DB_NAME = process.env.HARNESS_PG_DB ?? 'hexyrn_backup_restore_test';
const CONNECTION_STRING = `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_NAME}`;

// The dump/restore connection is DELIBERATELY a separate, narrowly-scoped
// role from the seeding/verification connection above - see
// docker/postgres-init/01-app-role.sh and backup.service.ts's realPgDump
// doc comment for why a full-database dump/restore against a
// FORCE ROW LEVEL SECURITY database genuinely needs BYPASSRLS, and why
// that must not be the same role the application (or this script's own
// seeding queries) uses day to day.
const BACKUP_DB_USER = process.env.HARNESS_BACKUP_PG_USER ?? 'hexyrn_backup';
const BACKUP_DB_PASSWORD = process.env.HARNESS_BACKUP_PG_PASSWORD ?? 'hexyrn_backup_test_password';
const BACKUP_CONNECTION_STRING = `postgres://${BACKUP_DB_USER}:${BACKUP_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_NAME}`;

let passed = 0;
let failed = 0;

function step(name: string, ok: boolean, detail?: string) {
  const mark = ok ? 'PASS' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`[${mark}] ${name}${detail ? ' - ' + detail : ''}`);
  if (ok) passed++;
  else failed++;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`=== Real pg_dump/pg_restore acceptance test ===`);
  const dumpVersion = await execFileAsync(PG_DUMP_PATH, ['--version']).then((r) => r.stdout.trim());
  const restoreVersion = await execFileAsync(PG_RESTORE_PATH, ['--version']).then((r) =>
    r.stdout.trim(),
  );
  // eslint-disable-next-line no-console
  console.log(`pg_dump: ${dumpVersion}`);
  // eslint-disable-next-line no-console
  console.log(`pg_restore: ${restoreVersion}`);
  // eslint-disable-next-line no-console
  console.log(
    `Target database (ISOLATED, not the dev/test DB): ${TEST_DB_NAME}@${TEST_DB_HOST}:${TEST_DB_PORT}`,
  );

  const pool = new Pool({ connectionString: CONNECTION_STRING });
  const storageDir = await fs.mkdtemp(join(tmpdir(), 'hexyrn-real-backup-storage-'));
  const backupDir = await fs.mkdtemp(join(tmpdir(), 'hexyrn-real-backup-'));

  // A single held connection for all seeding/verification queries below -
  // RLS's `SET LOCAL`/session `set_config` must stay on the SAME physical
  // connection for subsequent queries to see it; a bare `pool.query()` per
  // call can silently hop to a different pooled connection.
  const client = await pool.connect();

  try {
    // --- Seed: organisation, owner user, a Requisite-shaped row, an uploaded file ---
    const orgId = randomUUID();
    await client.query(
      `INSERT INTO installations (core_version) SELECT '0.1.0-real-backup-test' WHERE NOT EXISTS (SELECT 1 FROM installations)`,
    );
    const installation = await client.query<{ id: string }>('SELECT id FROM installations LIMIT 1');
    await client.query('SELECT set_config($1, $2, false)', ['app.current_organisation_id', orgId]);
    await client.query(
      `INSERT INTO organisations (id, installation_id, name, display_name, default_currency, timezone, locale, financial_year_start_month)
       VALUES ($1, $2, 'Real Backup Test Org', 'Real Backup Test Org', 'USD', 'UTC', 'en-US', 1)`,
      [orgId, installation.rows[0].id],
    );
    const { hashPassword, verifyPassword } = await import('../src/security/passwords');
    const REAL_PASSWORD = 'a-genuinely-real-test-password-1';
    const realPasswordHash = await hashPassword(REAL_PASSWORD);
    const userId = randomUUID();
    await client.query(
      `INSERT INTO user_accounts (id, organisation_id, email, password_hash, is_active) VALUES ($1, $2, 'real-backup-owner@test.local', $3, true)`,
      [userId, orgId, realPasswordHash],
    );

    // Real Requisite-shaped data (a supplier row) - proves an actual
    // application table (not just Core's own) round-trips through backup/restore.
    const supplierId = randomUUID();
    await client.query(
      `INSERT INTO requisite_suppliers (id, organisation_id, supplier_number, name, email, status) VALUES ($1, $2, 'SUP-00001', 'Real Backup Test Supplier Ltd', 'supplier@real-backup-test.example', 'active')`,
      [supplierId, orgId],
    );

    // application_licenses.app_id has a FK to installed_applications - register the app first.
    await client.query(
      `INSERT INTO installed_applications (app_id, display_name, version, major_version, requires_core_version, manifest) VALUES ('com.hexyrn.requisite', 'Hexyrn Requisite', '1.0.0', 1, '>=0.1.0', '{}') ON CONFLICT (app_id) DO NOTHING`,
    );

    // A real, genuinely signed test licence (Ed25519, same mechanism production uses).
    const { LicenseSigner } = await import('../src/vendor-tools/licensing/license-signer');
    const { TEST_LICENSE_PRIVATE_KEY_PEM } =
      await import('../src/vendor-tools/licensing/test-keys');
    const signer = new LicenseSigner(TEST_LICENSE_PRIVATE_KEY_PEM);
    const licence = signer.issue({
      appId: 'com.hexyrn.requisite',
      organisationId: orgId,
      majorVersion: 1,
      supportExpiresAt: null,
    });
    await client.query(
      `INSERT INTO application_licenses (organisation_id, app_id, licensed_major_version, license_payload, signature_valid_at) VALUES ($1, 'com.hexyrn.requisite', 1, $2, now())`,
      [orgId, JSON.stringify(licence)],
    );

    await fs.writeFile(
      join(storageDir, 'test-upload.txt'),
      'this is a real uploaded file for the backup/restore acceptance test',
    );

    step(
      'Seeded organisation/user/Requisite-supplier/licence in isolated database',
      true,
      `org=${orgId}`,
    );

    // --- Real backup via the actual pg_dump binary ---
    const { createBackup, verifyBackupIntegrity, restoreBackup, realPgDump, realPgRestore } =
      await import('../src/platform/backup/backup.service');
    const backupResult = await createBackup({
      destinationDir: backupDir,
      storageRootDir: storageDir,
      pool,
      runPgDump: realPgDump(BACKUP_CONNECTION_STRING, PG_DUMP_PATH),
    });
    step('Real pg_dump executed and produced a backup', true, backupResult.backupDir);

    const integrity = await verifyBackupIntegrity(backupDir);
    step(
      'Backup manifest/checksums verify (real dump file, real SHA-256)',
      integrity.valid,
      integrity.issues.join('; '),
    );

    // --- Alter/delete data ---
    await client.query('UPDATE user_accounts SET email = $1 WHERE id = $2', [
      'CORRUPTED@test.local',
      userId,
    ]);
    await client.query('DELETE FROM requisite_suppliers WHERE id = $1', [supplierId]);
    await client.query('DELETE FROM application_licenses WHERE organisation_id = $1', [orgId]);
    await fs.writeFile(join(storageDir, 'test-upload.txt'), 'CORRUPTED CONTENT');
    step(
      'Deliberately altered/deleted live data (user email, supplier, licence) + uploaded file',
      true,
    );

    // --- Real restore via the actual pg_restore binary ---
    const restoreResult = await restoreBackup({
      backupDir,
      storageRootDir: storageDir,
      runPgRestore: realPgRestore(BACKUP_CONNECTION_STRING, PG_RESTORE_PATH),
      confirmed: true,
    });
    step('Real pg_restore executed', true, `filesRestored=${restoreResult.filesRestored}`);

    // --- Verify original data returned - pg_restore reconnects the
    // server-side state, but this script's own `client` connection may
    // have had its RLS session-level set_config wiped by the restore
    // (which drops/recreates the whole database's contents) - re-assert
    // org context defensively before reading. ---
    await client.query('SELECT set_config($1, $2, false)', ['app.current_organisation_id', orgId]);
    const afterRestore = await client.query<{ email: string }>(
      'SELECT email FROM user_accounts WHERE id = $1',
      [userId],
    );
    step(
      'Original user email restored (real pg_restore, not a fake)',
      afterRestore.rows[0]?.email === 'real-backup-owner@test.local',
      afterRestore.rows[0]?.email,
    );

    const fileContent = await fs.readFile(join(storageDir, 'test-upload.txt'), 'utf8');
    step(
      'Original uploaded file content restored',
      fileContent.includes('real uploaded file'),
      fileContent.slice(0, 40),
    );

    // Verify authentication state: the restored password hash genuinely
    // still verifies against the real plaintext password (not just that
    // SOME hash string came back, but that Argon2id verification of the
    // exact original credential succeeds after a real restore).
    const passwordRow = await client.query<{ password_hash: string }>(
      'SELECT password_hash FROM user_accounts WHERE id = $1',
      [userId],
    );
    const passwordStillValid = await verifyPassword(
      passwordRow.rows[0].password_hash,
      REAL_PASSWORD,
    );
    step(
      'Authentication state restored - the real password still verifies against the restored hash',
      passwordStillValid,
    );

    // Verify the deleted Requisite supplier came back.
    const supplierRow = await client.query<{ name: string }>(
      'SELECT name FROM requisite_suppliers WHERE id = $1',
      [supplierId],
    );
    step(
      'Deleted Requisite supplier row restored',
      supplierRow.rows[0]?.name === 'Real Backup Test Supplier Ltd',
      supplierRow.rows[0]?.name,
    );

    // Verify the deleted licence came back AND still verifies (real Ed25519 check via LicenseVerifier).
    const { LicenseVerifier } = await import('../src/platform/licensing/license-verifier');
    const licenceRow = await client.query<{ license_payload: any }>(
      'SELECT license_payload FROM application_licenses WHERE organisation_id = $1',
      [orgId],
    );
    const verifier = new LicenseVerifier();
    const licenceVerification = licenceRow.rows[0]
      ? verifier.verify(licenceRow.rows[0].license_payload, {
          appId: 'com.hexyrn.requisite',
          organisationId: orgId,
          majorVersion: 1,
        })
      : { valid: false };
    step(
      'Deleted licence row restored AND still cryptographically verifies',
      licenceVerification.valid,
      JSON.stringify(licenceVerification),
    );

    // Verify overall application functionality: a real, ordinary org-scoped
    // query (the same shape any controller would run) succeeds post-restore.
    const functionalCheck = await client.query(
      'SELECT COUNT(*)::int AS n FROM requisite_suppliers WHERE organisation_id = $1',
      [orgId],
    );
    step(
      'Application functionality post-restore: ordinary org-scoped query succeeds',
      functionalCheck.rows[0].n === 1,
    );
  } catch (err) {
    step(
      'Unexpected error during acceptance test',
      false,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    client.release();
    await pool.end();
  }

  // eslint-disable-next-line no-console
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
